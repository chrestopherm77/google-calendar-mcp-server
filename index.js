#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { google } from 'googleapis';
import fs from 'fs/promises';
import http from 'http';
import url from 'url';

class GoogleCalendarServer {
  constructor() {
    this.server = new Server(
      {
        name: 'google-calendar-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.tokens = new Map(); // Armazenamento em memória dos tokens
    this.setupToolHandlers();
    
    // Erro handler
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
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
                default: 10,
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
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const { name, arguments: args } = request.params;

        switch (name) {
          case 'get_auth_url':
            return await this.getAuthUrl();
          case 'get_auth_status':
            return await this.getAuthStatus();
          case 'list_events':
            return await this.listEvents(args);
          case 'create_event':
            return await this.createEvent(args);
          case 'delete_event':
            return await this.deleteEvent(args);
          case 'update_event':
            return await this.updateEvent(args);
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Ferramenta desconhecida: ${name}`
            );
        }
      } catch (error) {
        console.error('Erro ao executar ferramenta:', error);
        throw new McpError(
          ErrorCode.InternalError,
          `Erro ao executar ${request.params.name}: ${error.message}`
        );
      }
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

  async getAuthUrl() {
    try {
      const serverUrl = process.env.RENDER_EXTERNAL_URL || 'http://localhost:10000';
      
      return {
        content: [
          {
            type: 'text',
            text: `🔐 Para autenticar com o Google Calendar:\n\n1. Acesse: ${serverUrl}/auth\n2. Clique em "Autenticar com Google"\n3. Faça login e autorize o acesso\n4. Após autorizar, você poderá usar todas as ferramentas!\n\n⚠️ Importante: Acesse essa URL no seu navegador.`,
          },
        ],
      };
    } catch (error) {
      throw new Error(`Erro ao gerar URL de autenticação: ${error.message}`);
    }
  }

  async getAuthStatus() {
    const isAuthenticated = this.tokens.has('default');
    
    return {
      content: [
        {
          type: 'text',
          text: isAuthenticated 
            ? '✅ Autenticado com sucesso! Você pode usar todas as ferramentas do Google Calendar.'
            : '❌ Não autenticado. Use get_auth_url para obter o link de autenticação.',
        },
      ],
    };
  }

  async getAuthenticatedClient() {
    const credentials = await this.getCredentials();
    const { client_secret, client_id, redirect_uris } = credentials.web || credentials.installed;

    const oAuth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris[0]
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

    throw new Error('Não autenticado. Use get_auth_url para obter o link de autenticação.');
  }

  async listEvents(args = {}) {
    try {
      const auth = await this.getAuthenticatedClient();
      const calendar = google.calendar({ version: 'v3', auth });

      const response = await calendar.events.list({
        calendarId: 'primary',
        timeMin: args.timeMin || new Date().toISOString(),
        timeMax: args.timeMax,
        maxResults: args.maxResults || 10,
        singleEvents: true,
        orderBy: 'startTime',
      });

      const events = response.data.items || [];
      
      if (events.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'Nenhum evento encontrado.',
            },
          ],
        };
      }

      const eventsList = events.map((event) => {
        const start = event.start.dateTime || event.start.date;
        const end = event.end.dateTime || event.end.date;
        return `ID: ${event.id}\nTítulo: ${event.summary}\nInício: ${start}\nFim: ${end}\nDescrição: ${event.description || 'N/A'}\nLocal: ${event.location || 'N/A'}\n---`;
      }).join('\n');

      return {
        content: [
          {
            type: 'text',
            text: `Eventos encontrados:\n\n${eventsList}`,
          },
        ],
      };
    } catch (error) {
      throw new Error(`Erro ao listar eventos: ${error.message}`);
    }
  }

  async createEvent(args) {
    try {
      const auth = await this.getAuthenticatedClient();
      const calendar = google.calendar({ version: 'v3', auth });

      const event = {
        summary: args.summary,
        description: args.description,
        location: args.location,
        start: {
          dateTime: args.start,
        },
        end: {
          dateTime: args.end,
        },
      };

      const response = await calendar.events.insert({
        calendarId: 'primary',
        resource: event,
      });

      return {
        content: [
          {
            type: 'text',
            text: `Evento criado com sucesso!\nID: ${response.data.id}\nTítulo: ${response.data.summary}\nInício: ${response.data.start.dateTime}\nFim: ${response.data.end.dateTime}`,
          },
        ],
      };
    } catch (error) {
      throw new Error(`Erro ao criar evento: ${error.message}`);
    }
  }

  async deleteEvent(args) {
    try {
      const auth = await this.getAuthenticatedClient();
      const calendar = google.calendar({ version: 'v3', auth });

      try {
        const eventResponse = await calendar.events.get({
          calendarId: 'primary',
          eventId: args.eventId,
        });
        
        const eventTitle = eventResponse.data.summary;
        
        await calendar.events.delete({
          calendarId: 'primary',
          eventId: args.eventId,
        });

        return {
          content: [
            {
              type: 'text',
              text: `✅ Evento deletado com sucesso!\nID: ${args.eventId}\nTítulo: ${eventTitle}`,
            },
          ],
        };
      } catch (error) {
        if (error.code === 404) {
          return {
            content: [
              {
                type: 'text',
                text: `❌ Evento não encontrado!\nID: ${args.eventId}\nVerifique se o ID está correto.`,
              },
            ],
          };
        }
        throw error;
      }
    } catch (error) {
      throw new Error(`Erro ao deletar evento: ${error.message}`);
    }
  }

  async updateEvent(args) {
    try {
      const auth = await this.getAuthenticatedClient();
      const calendar = google.calendar({ version: 'v3', auth });

      const currentEvent = await calendar.events.get({
        calendarId: 'primary',
        eventId: args.eventId,
      });

      const updatedEvent = {
        summary: args.summary || currentEvent.data.summary,
        description: args.description !== undefined ? args.description : currentEvent.data.description,
        location: args.location !== undefined ? args.location : currentEvent.data.location,
        start: args.start ? { dateTime: args.start } : currentEvent.data.start,
        end: args.end ? { dateTime: args.end } : currentEvent.data.end,
      };

      const response = await calendar.events.update({
        calendarId: 'primary',
        eventId: args.eventId,
        resource: updatedEvent,
      });

      return {
        content: [
          {
            type: 'text',
            text: `✅ Evento atualizado com sucesso!\nID: ${response.data.id}\nTítulo: ${response.data.summary}\nInício: ${response.data.start.dateTime || response.data.start.date}\nFim: ${response.data.end.dateTime || response.data.end.date}`,
          },
        ],
      };
    } catch (error) {
      if (error.code === 404) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Evento não encontrado!\nID: ${args.eventId}\nVerifique se o ID está correto.`,
            },
          ],
        };
      }
      throw new Error(`Erro ao atualizar evento: ${error.message}`);
    }
  }

  async run() {
    // Para desenvolvimento com stdio
    if (process.env.NODE_ENV !== 'production') {
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error('Google Calendar MCP server rodando em stdio transport');
    }
    
    // Para produção com HTTP server
    this.createHttpServer();
  }

  createHttpServer() {
    const server = http.createServer(async (req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      const parsedUrl = url.parse(req.url, true);
      const path = parsedUrl.pathname;

      try {
        if (req.method === 'GET' && path === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(this.getHomePage());
        } 
        // API Endpoints para ferramentas de automação
        else if (req.method === 'GET' && path === '/api/tools') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          const tools = await this.server.requestHandler.handle({
            method: 'tools/list',
            params: {}
          });
          res.end(JSON.stringify(tools));
        }
        else if (req.method === 'POST' && path === '/api/tools/call') {
          let body = '';
          req.on('data', chunk => body += chunk.toString());
          req.on('end', async () => {
            try {
              const { tool, params } = JSON.parse(body);
              const result = await this.callTool(tool, params);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, data: result }));
            } catch (error) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: error.message }));
            }
          });
        }
        else if (req.method === 'GET' && path === '/auth') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(await this.getAuthPage());
        } else if (req.method === 'GET' && path === '/auth/google') {
          await this.handleGoogleAuth(req, res);
        } else if (req.method === 'GET' && path === '/auth/callback') {
          await this.handleAuthCallback(req, res, parsedUrl.query);
        } else if (req.method === 'GET' && path === '/status') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            authenticated: this.tokens.has('default'),
            timestamp: new Date().toISOString()
          }));
        } else {
          res.writeHead(404);
          res.end('Not Found');
        }
      } catch (error) {
        console.error('Erro no servidor HTTP:', error);
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    });

    const port = process.env.PORT || 10000;
    server.listen(port, () => {
      console.log(`🚀 Servidor HTTP rodando na porta ${port}`);
      console.log(`📋 API endpoints disponíveis:`);
      console.log(`   GET  /api/tools - Lista todas as ferramentas`);
      console.log(`   POST /api/tools/call - Executa uma ferramenta`);
      console.log(`   GET  /status - Status de autenticação`);
    });
  }

  // Método auxiliar para chamar ferramentas via HTTP
  async callTool(toolName, params) {
    switch (toolName) {
      case 'get_auth_url':
        return await this.getAuthUrl();
      case 'get_auth_status':
        return await this.getAuthStatus();
      case 'list_events':
        return await this.listEvents(params);
      case 'create_event':
        return await this.createEvent(params);
      case 'delete_event':
        return await this.deleteEvent(params);
      case 'update_event':
        return await this.updateEvent(params);
      default:
        throw new Error(`Ferramenta desconhecida: ${toolName}`);
    }
  }

  getHomePage() {
    const isAuthenticated = this.tokens.has('default');
    
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Google Calendar MCP Server</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; }
          .container { background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 800px; margin: 0 auto; }
          .status { font-weight: bold; padding: 15px; border-radius: 5px; margin: 20px 0; }
          .status.success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
          .status.warning { background: #fff3cd; color: #856404; border: 1px solid #ffeaa7; }
          .tool { background: #f8f9fa; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 4px solid #007bff; }
          .tool-name { font-weight: bold; color: #007bff; }
          .tool-desc { color: #666; margin-top: 5px; }
          .auth-button { background: #4285f4; color: white; padding: 15px 30px; border: none; border-radius: 5px; font-size: 16px; cursor: pointer; text-decoration: none; display: inline-block; margin: 20px 0; }
          .auth-button:hover { background: #357ae8; }
          .auth-button:disabled { background: #ccc; cursor: not-allowed; }
          h1 { color: #333; }
          .emoji { font-size: 1.2em; }
          .refresh-btn { background: #28a745; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; margin-left: 10px; }
          .api-section { background: #e7f3ff; padding: 20px; border-radius: 5px; margin: 20px 0; }
          .endpoint { background: #fff; padding: 10px; margin: 5px 0; border-radius: 3px; font-family: monospace; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1><span class="emoji">📅</span> Google Calendar MCP Server</h1>
          
          <div class="status ${isAuthenticated ? 'success' : 'warning'}">
            <span class="emoji">${isAuthenticated ? '✅' : '⚠️'}</span>
            <strong>Status de Autenticação:</strong> 
            ${isAuthenticated ? 'Autenticado com sucesso!' : 'Não autenticado'}
            <button class="refresh-btn" onclick="location.reload()">🔄 Atualizar</button>
          </div>
          
          ${!isAuthenticated ? `
            <div style="text-align: center; margin: 30px 0;">
              <a href="/auth" class="auth-button">
                🔐 Autenticar com Google Calendar
              </a>
              <p style="color: #666; margin-top: 10px;">
                É necessário autenticar para usar as ferramentas do Google Calendar
              </p>
            </div>
          ` : `
            <div style="text-align: center; margin: 30px 0;">
              <p style="color: #28a745; font-weight: bold;">
                ✅ Pronto para usar! Agora você pode usar todas as ferramentas.
              </p>
            </div>
          `}

          <div class="api-section">
            <h2><span class="emoji">🔌</span> API Endpoints para Automação:</h2>
            <div class="endpoint">GET /api/tools - Lista todas as ferramentas disponíveis</div>
            <div class="endpoint">POST /api/tools/call - Executa uma ferramenta específica</div>
            <div class="endpoint">GET /status - Verifica status de autenticação</div>
          </div>
          
          <h2><span class="emoji">🛠️</span> Ferramentas disponíveis:</h2>
          
          <div class="tool">
            <div class="tool-name">get_auth_url</div>
            <div class="tool-desc">Obter URL de autenticação</div>
          </div>
          
          <div class="tool">
            <div class="tool-name">get_auth_status</div>
            <div class="tool-desc">Verificar status da autenticação</div>
          </div>
          
          <div class="tool">
            <div class="tool-name">list_events</div>
            <div class="tool-desc">Listar eventos do Google Calendar</div>
          </div>
          
          <div class="tool">
            <div class="tool-name">create_event</div>
            <div class="tool-desc">Criar novo evento</div>
          </div>
          
          <div class="tool">
            <div class="tool-name">delete_event</div>
            <div class="tool-desc">Deletar evento existente</div>
          </div>
          
          <div class="tool">
            <div class="tool-name">update_event</div>
            <div class="tool-desc">Atualizar evento existente</div>
          </div>
          
          <div style="margin-top: 30px; padding: 20px; background: #e9ecef; border-radius: 5px;">
            <h3><span class="emoji">💡</span> Como usar com automação:</h3>
            <ol>
              <li>Autentique-se primeiro (botão acima)</li>
              <li>Use a URL: <code>${process.env.RENDER_EXTERNAL_URL || 'http://localhost:10000'}</code></li>
              <li>Faça chamadas para os endpoints da API</li>
            </ol>
          </div>
        </div>
        
        <script>
          // Auto-refresh para verificar status de autenticação
          setInterval(() => {
            fetch('/status')
              .then(r => r.json())
              .then(data => {
                if (data.authenticated !== ${isAuthenticated}) {
                  location.reload();
                }
              })
              .catch(() => {});
          }, 5000);
        </script>
      </body>
      </html>
    `;
  }

  async getAuthPage() {
    const credentials = await this.getCredentials();
    const { client_secret, client_id } = credentials.web || credentials.installed;
    
    // Usar a URL atual do Render
    const serverUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 10000}`;
    const redirectUri = `${serverUrl}/auth/callback`;

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

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Autenticação - Google Calendar MCP</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; text-align: center; }
          .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 500px; margin: 0 auto; }
          .auth-button { background: #4285f4; color: white; padding: 20px 40px; border: none; border-radius: 5px; font-size: 18px; cursor: pointer; text-decoration: none; display: inline-block; margin: 20px 0; }
          .auth-button:hover { background: #357ae8; }
          .step { margin: 20px 0; padding: 15px; background: #f8f9fa; border-radius: 5px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🔐 Autenticação Google Calendar</h1>
          
          <div class="step">
            <h3>📋 Passo a passo:</h3>
            <ol style="text-align: left;">
              <li>Clique no botão abaixo</li>
              <li>Faça login na sua conta Google</li>
              <li>Autorize o acesso ao Google Calendar</li>
              <li>Você será redirecionado de volta</li>
            </ol>
          </div>
          
          <a href="${authUrl}" class="auth-button">
            📅 Autenticar com Google Calendar
          </a>
          
          <div style="margin-top: 30px; color: #666;">
            <p>⚠️ Importante: Use a mesma conta Google que você quer acessar o calendário</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  async handleAuthCallback(req, res, query) {
    try {
      if (query.error) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <html>
            <body style="font-family: Arial; text-align: center; padding: 50px;">
              <h2>❌ Erro na Autenticação</h2>
              <p>Erro: ${query.error}</p>
              <a href="/auth">Tentar novamente</a>
            </body>
          </html>
        `);
        return;
      }

      if (!query.code) {
        throw new Error('Código de autorização não recebido');
      }

      const credentials = await this.getCredentials();
      const { client_secret, client_id } = credentials.web || credentials.installed;
      
      const serverUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 10000}`;
      const redirectUri = `${serverUrl}/auth/callback`;

      const oAuth2Client = new google.auth.OAuth2(
        client_id,
        client_secret,
        redirectUri
      );

      const { tokens } = await oAuth2Client.getToken(query.code);
      
      // Salva o token na memória
      this.tokens.set('default', tokens);
      
      console.log('✅ Token salvo com sucesso!');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <html>
          <head>
            <title>Sucesso - Google Calendar MCP</title>
            <style>
              body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
              .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 500px; margin: 0 auto; }
              .success { color: #28a745; }
              .button { background: #007bff; color: white; padding: 15px 30px; border: none; border-radius: 5px; font-size: 16px; cursor: pointer; text-decoration: none; display: inline-block; margin: 20px 10px; }
              .button:hover { opacity: 0.9; }
            </style>
            <script>
              // Auto-redirect após 3 segundos
              setTimeout(() => {
                window.location.href = '/';
              }, 3000);
            </script>
          </head>
          <body>
            <div class="container">
              <h1 class="success">✅ Autenticação realizada com sucesso!</h1>
              <p>Agora você pode usar todas as ferramentas do Google Calendar.</p>
              
              <div style="margin: 30px 0;">
                <p>🔄 Redirecionando automaticamente em 3 segundos...</p>
              </div>
              
              <div>
                <a href="/" class="button">🏠 Voltar ao início</a>
                <a href="/api/tools" class="button">📋 Ver APIs</a>
              </div>
            </div>
          </body>
        </html>
      `);
    } catch (error) {
      console.error('Erro no callback de autenticação:', error);
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <html>
          <body style="font-family: Arial; text-align: center; padding: 50px;">
            <h2>❌ Erro na Autenticação</h2>
            <p>Erro: ${error.message}</p>
            <a href="/auth">Tentar novamente</a>
          </body>
        </html>
      `);
    }
  }

  async handleGoogleAuth(req, res) {
    // Redirect para a página de autenticação
    res.writeHead(302, { Location: '/auth' });
    res.end();
  }
}

// Criar e rodar o servidor
const server = new GoogleCalendarServer();
server.run().catch(console.error);
