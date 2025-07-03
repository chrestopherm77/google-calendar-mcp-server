#!/usr/bin/env node

import express from 'express';
import cors from 'cors';
import { google } from 'googleapis';
import fs from 'fs/promises';
import path from 'path';

class GoogleCalendarRestServer {
  constructor() {
    this.app = express();
    this.tokens = new Map(); // Armazenamento em memória dos tokens
    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    // CORS para permitir chamadas de qualquer origem
    this.app.use(cors({
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
    }));

    // Parse JSON
    this.app.use(express.json());
    
    // Parse URL encoded
    this.app.use(express.urlencoded({ extended: true }));

    // Middleware de log
    this.app.use((req, res, next) => {
      console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
      next();
    });
  }

  async getCredentials() {
    try {
      // Tenta ler das variáveis de ambiente primeiro (produção)
      if (process.env.GOOGLE_CALENDAR_CREDENTIALS) {
        return JSON.parse(process.env.GOOGLE_CALENDAR_CREDENTIALS);
      }
      
      // Fallback para arquivo local (desenvolvimento)
      const credentialsData = await fs.readFile('gcp-oauth-keys.json', 'utf8');
      return JSON.parse(credentialsData);
    } catch (error) {
      throw new Error('Não foi possível carregar as credenciais do Google Calendar');
    }
  }

  setupRoutes() {
    // Página inicial com informações da API
    this.app.get('/', (req, res) => {
      res.json({
        name: 'Google Calendar REST API Server',
        version: '1.0.0',
        description: 'REST API para integração com Google Calendar (estilo MCP)',
        endpoints: {
          auth: {
            'GET /auth/url': 'Obter URL de autenticação',
            'GET /auth/status': 'Verificar status de autenticação',
            'GET /auth/callback': 'Callback de autenticação (usado pelo Google)',
          },
          calendar: {
            'GET /calendar/events': 'Listar eventos',
            'POST /calendar/events': 'Criar evento',
            'PUT /calendar/events/:id': 'Atualizar evento',
            'DELETE /calendar/events/:id': 'Deletar evento'
          },
          mcp: {
            'GET /mcp/tools': 'Listar ferramentas disponíveis (compatível com MCP)',
            'POST /mcp/call': 'Executar ferramenta (compatível com MCP)'
          }
        },
        authentication: {
          status: this.tokens.has('default') ? 'authenticated' : 'not_authenticated',
          method: 'OAuth 2.0'
        }
      });
    });

    // ===== ROTAS DE AUTENTICAÇÃO =====
    this.app.get('/auth/url', async (req, res) => {
      try {
        const credentials = await this.getCredentials();
        const { client_secret, client_id } = credentials.web || credentials.installed;
        
        // Usar URL base do servidor atual
        const baseUrl = process.env.RENDER_EXTERNAL_URL || 
                       process.env.BASE_URL || 
                       `http://localhost:${process.env.PORT || 3000}`;
        
        const redirectUri = `${baseUrl}/auth/callback`;

        const oAuth2Client = new google.auth.OAuth2(
          client_id,
          client_secret,
          redirectUri
        );

        const authUrl = oAuth2Client.generateAuthUrl({
          access_type: 'offline',
          scope: ['https://www.googleapis.com/auth/calendar'],
          prompt: 'consent'
        });

        res.json({
          auth_url: authUrl,
          redirect_uri: redirectUri,
          instructions: 'Acesse a auth_url no navegador, faça login e autorize o acesso'
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/auth/status', (req, res) => {
      const isAuthenticated = this.tokens.has('default');
      res.json({
        authenticated: isAuthenticated,
        status: isAuthenticated ? 'ready' : 'authentication_required',
        timestamp: new Date().toISOString()
      });
    });

    this.app.get('/auth/callback', async (req, res) => {
      try {
        const { code, error } = req.query;

        if (error) {
          return res.status(400).json({ error: `Authentication error: ${error}` });
        }

        if (!code) {
          return res.status(400).json({ error: 'Authorization code not received' });
        }

        const credentials = await this.getCredentials();
        const { client_secret, client_id } = credentials.web || credentials.installed;
        
        const baseUrl = process.env.RENDER_EXTERNAL_URL || 
                       process.env.BASE_URL || 
                       `http://localhost:${process.env.PORT || 3000}`;
        
        const redirectUri = `${baseUrl}/auth/callback`;

        const oAuth2Client = new google.auth.OAuth2(
          client_id,
          client_secret,
          redirectUri
        );

        const { tokens } = await oAuth2Client.getToken(code);
        
        // Salva o token na memória
        this.tokens.set('default', tokens);
        
        console.log('✅ Token salvo com sucesso!');

        // Resposta em JSON para APIs ou HTML para navegador
        if (req.headers.accept && req.headers.accept.includes('application/json')) {
          res.json({
            success: true,
            message: 'Authentication successful',
            authenticated: true
          });
        } else {
          // HTML para visualização no navegador
          res.send(`
            <!DOCTYPE html>
            <html>
            <head>
              <title>Autenticação Concluída</title>
              <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
                .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 500px; margin: 0 auto; }
                .success { color: #28a745; }
              </style>
            </head>
            <body>
              <div class="container">
                <h1 class="success">✅ Autenticação realizada com sucesso!</h1>
                <p>Agora você pode usar a API do Google Calendar.</p>
                <p><strong>Status:</strong> Pronto para uso</p>
                <p><a href="/">Voltar à página inicial</a></p>
              </div>
            </body>
            </html>
          `);
        }
      } catch (error) {
        console.error('Erro no callback de autenticação:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // ===== ROTAS DE CALENDÁRIO =====
    this.app.get('/calendar/events', async (req, res) => {
      try {
        const auth = await this.getAuthenticatedClient();
        const calendar = google.calendar({ version: 'v3', auth });

        const {
          maxResults = 10,
          timeMin = new Date().toISOString(),
          timeMax
        } = req.query;

        const response = await calendar.events.list({
          calendarId: 'primary',
          timeMin,
          timeMax,
          maxResults: parseInt(maxResults),
          singleEvents: true,
          orderBy: 'startTime',
        });

        const events = response.data.items || [];
        
        res.json({
          events: events.map(event => ({
            id: event.id,
            summary: event.summary,
            description: event.description,
            location: event.location,
            start: event.start.dateTime || event.start.date,
            end: event.end.dateTime || event.end.date,
            status: event.status,
            htmlLink: event.htmlLink
          })),
          total: events.length
        });
      } catch (error) {
        res.status(error.code === 401 ? 401 : 500).json({ error: error.message });
      }
    });

    this.app.post('/calendar/events', async (req, res) => {
      try {
        const auth = await this.getAuthenticatedClient();
        const calendar = google.calendar({ version: 'v3', auth });

        const { summary, description, location, start, end } = req.body;

        if (!summary || !start || !end) {
          return res.status(400).json({ 
            error: 'Missing required fields: summary, start, end' 
          });
        }

        const event = {
          summary,
          description,
          location,
          start: { dateTime: start },
          end: { dateTime: end },
        };

        const response = await calendar.events.insert({
          calendarId: 'primary',
          resource: event,
        });

        res.json({
          success: true,
          event: {
            id: response.data.id,
            summary: response.data.summary,
            start: response.data.start.dateTime,
            end: response.data.end.dateTime,
            htmlLink: response.data.htmlLink
          }
        });
      } catch (error) {
        res.status(error.code === 401 ? 401 : 500).json({ error: error.message });
      }
    });

    this.app.put('/calendar/events/:id', async (req, res) => {
      try {
        const auth = await this.getAuthenticatedClient();
        const calendar = google.calendar({ version: 'v3', auth });
        const { id } = req.params;

        // Busca evento atual
        const currentEvent = await calendar.events.get({
          calendarId: 'primary',
          eventId: id,
        });

        const { summary, description, location, start, end } = req.body;

        const updatedEvent = {
          summary: summary || currentEvent.data.summary,
          description: description !== undefined ? description : currentEvent.data.description,
          location: location !== undefined ? location : currentEvent.data.location,
          start: start ? { dateTime: start } : currentEvent.data.start,
          end: end ? { dateTime: end } : currentEvent.data.end,
        };

        const response = await calendar.events.update({
          calendarId: 'primary',
          eventId: id,
          resource: updatedEvent,
        });

        res.json({
          success: true,
          event: {
            id: response.data.id,
            summary: response.data.summary,
            start: response.data.start.dateTime || response.data.start.date,
            end: response.data.end.dateTime || response.data.end.date,
            htmlLink: response.data.htmlLink
          }
        });
      } catch (error) {
        if (error.code === 404) {
          res.status(404).json({ error: 'Event not found' });
        } else {
          res.status(error.code === 401 ? 401 : 500).json({ error: error.message });
        }
      }
    });

    this.app.delete('/calendar/events/:id', async (req, res) => {
      try {
        const auth = await this.getAuthenticatedClient();
        const calendar = google.calendar({ version: 'v3', auth });
        const { id } = req.params;

        // Busca evento antes de deletar para retornar informações
        const eventResponse = await calendar.events.get({
          calendarId: 'primary',
          eventId: id,
        });
        
        const eventTitle = eventResponse.data.summary;
        
        await calendar.events.delete({
          calendarId: 'primary',
          eventId: id,
        });

        res.json({
          success: true,
          message: 'Event deleted successfully',
          deleted_event: {
            id,
            title: eventTitle
          }
        });
      } catch (error) {
        if (error.code === 404) {
          res.status(404).json({ error: 'Event not found' });
        } else {
          res.status(error.code === 401 ? 401 : 500).json({ error: error.message });
        }
      }
    });

    // ===== ROTAS COMPATÍVEIS COM MCP =====
    this.app.get('/mcp/tools', (req, res) => {
      res.json({
        tools: [
          {
            name: 'get_auth_url',
            description: 'Obter URL de autenticação do Google Calendar',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'get_auth_status',
            description: 'Verificar status da autenticação',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'list_events',
            description: 'Listar eventos do Google Calendar',
            inputSchema: {
              type: 'object',
              properties: {
                maxResults: {
                  type: 'number',
                  description: 'Número máximo de eventos para retornar (padrão: 10)',
                },
                timeMin: {
                  type: 'string',
                  description: 'Data/hora mínima (ISO 8601)',
                },
                timeMax: {
                  type: 'string',
                  description: 'Data/hora máxima (ISO 8601)',
                },
              },
            },
          },
          {
            name: 'create_event',
            description: 'Criar um novo evento no Google Calendar',
            inputSchema: {
              type: 'object',
              properties: {
                summary: {
                  type: 'string',
                  description: 'Título do evento',
                },
                description: {
                  type: 'string',
                  description: 'Descrição do evento',
                },
                start: {
                  type: 'string',
                  description: 'Data/hora de início (ISO 8601)',
                },
                end: {
                  type: 'string',
                  description: 'Data/hora de fim (ISO 8601)',
                },
                location: {
                  type: 'string',
                  description: 'Local do evento',
                },
              },
              required: ['summary', 'start', 'end'],
            },
          },
          {
            name: 'delete_event',
            description: 'Deletar um evento do Google Calendar',
            inputSchema: {
              type: 'object',
              properties: {
                eventId: {
                  type: 'string',
                  description: 'ID do evento a ser deletado',
                },
              },
              required: ['eventId'],
            },
          },
          {
            name: 'update_event',
            description: 'Atualizar um evento existente no Google Calendar',
            inputSchema: {
              type: 'object',
              properties: {
                eventId: {
                  type: 'string',
                  description: 'ID do evento a ser atualizado',
                },
                summary: {
                  type: 'string',
                  description: 'Novo título do evento',
                },
                description: {
                  type: 'string',
                  description: 'Nova descrição do evento',
                },
                start: {
                  type: 'string',
                  description: 'Nova data/hora de início (ISO 8601)',
                },
                end: {
                  type: 'string',
                  description: 'Nova data/hora de fim (ISO 8601)',
                },
                location: {
                  type: 'string',
                  description: 'Novo local do evento',
                },
              },
              required: ['eventId'],
            },
          },
        ],
      });
    });

    this.app.post('/mcp/call', async (req, res) => {
      try {
        const { tool, params } = req.body;

        if (!tool) {
          return res.status(400).json({ error: 'Missing tool name' });
        }

        let result;
        switch (tool) {
          case 'get_auth_url':
            const authResponse = await fetch(`${req.protocol}://${req.get('host')}/auth/url`);
            result = await authResponse.json();
            break;
          case 'get_auth_status':
            const statusResponse = await fetch(`${req.protocol}://${req.get('host')}/auth/status`);
            result = await statusResponse.json();
            break;
          case 'list_events':
            const eventsResponse = await fetch(`${req.protocol}://${req.get('host')}/calendar/events?${new URLSearchParams(params || {})}`);
            result = await eventsResponse.json();
            break;
          case 'create_event':
            const createResponse = await fetch(`${req.protocol}://${req.get('host')}/calendar/events`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(params)
            });
            result = await createResponse.json();
            break;
          case 'delete_event':
            const deleteResponse = await fetch(`${req.protocol}://${req.get('host')}/calendar/events/${params.eventId}`, {
              method: 'DELETE'
            });
            result = await deleteResponse.json();
            break;
          case 'update_event':
            const { eventId, ...updateParams } = params;
            const updateResponse = await fetch(`${req.protocol}://${req.get('host')}/calendar/events/${eventId}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(updateParams)
            });
            result = await updateResponse.json();
            break;
          default:
            return res.status(400).json({ error: `Unknown tool: ${tool}` });
        }

        res.json({
          success: true,
          tool,
          result
        });
      } catch (error) {
        res.status(500).json({ 
          success: false, 
          error: error.message,
          tool: req.body.tool 
        });
      }
    });

    // Tratamento de rotas não encontradas
    this.app.use((req, res) => {
      res.status(404).json({
        error: 'Route not found',
        available_endpoints: [
          'GET /',
          'GET /auth/url',
          'GET /auth/status',
          'GET /calendar/events',
          'POST /calendar/events',
          'PUT /calendar/events/:id',
          'DELETE /calendar/events/:id',
          'GET /mcp/tools',
          'POST /mcp/call'
        ]
      });
    });
  }

  async getAuthenticatedClient() {
    const credentials = await this.getCredentials();
    const { client_secret, client_id } = credentials.web || credentials.installed;

    const baseUrl = process.env.RENDER_EXTERNAL_URL || 
                   process.env.BASE_URL || 
                   `http://localhost:${process.env.PORT || 3000}`;
    
    const redirectUri = `${baseUrl}/auth/callback`;

    const oAuth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirectUri
    );

    // Busca o token salvo
    const token = this.tokens.get('default');
    if (token) {
      oAuth2Client.setCredentials(token);
      
      // Verifica se o token precisa ser renovado
      if (token.expiry_date && token.expiry_date <= Date.now()) {
        try {
          const { credentials } = await oAuth2Client.refreshAccessToken();
          this.tokens.set('default', credentials);
          oAuth2Client.setCredentials(credentials);
        } catch (error) {
          this.tokens.delete('default');
          throw new Error('Token expirado. Faça nova autenticação.');
        }
      }
      
      return oAuth2Client;
    }

    throw new Error('Não autenticado. Use /auth/url para obter o link de autenticação.');
  }

  start() {
    const port = process.env.PORT || 3000;
    
    this.app.listen(port, () => {
      console.log(`🚀 Google Calendar REST API Server rodando na porta ${port}`);
      console.log(`📋 Documentação da API: http://localhost:${port}/`);
      console.log(`🔐 Autenticação: http://localhost:${port}/auth/url`);
      console.log(`📅 Endpoints de calendário:`);
      console.log(`   GET    /calendar/events`);
      console.log(`   POST   /calendar/events`);
      console.log(`   PUT    /calendar/events/:id`);
      console.log(`   DELETE /calendar/events/:id`);
      console.log(`🔧 Endpoints compatíveis com MCP:`);
      console.log(`   GET    /mcp/tools`);
      console.log(`   POST   /mcp/call`);
    });
  }
}

// Inicializar servidor
const server = new GoogleCalendarRestServer();
server.start();

export default GoogleCalendarRestServer;
