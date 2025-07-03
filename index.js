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
      const credentials = await this.getCredentials();
      const { client_secret, client_id, redirect_uris } = credentials.web || credentials.installed;

      const oAuth2Client = new google.auth.OAuth2(
        client_id,
        client_secret,
        redirect_uris[0]
      );

      const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/calendar'],
      });

      return {
        content: [
          {
            type: 'text',
            text: `URL de autenticação: ${authUrl}\n\nAcesse esta URL para autorizar o acesso ao Google Calendar.`,
          },
        ],
      };
    } catch (error) {
      throw new Error(`Erro ao gerar URL de autenticação: ${error.message}`);
    }
  }

  async getAuthenticatedClient() {
    const credentials = await this.getCredentials();
    const { client_secret, client_id, redirect_uris } = credentials.web || credentials.installed;

    const oAuth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris[0]
    );

    // Em um ambiente real, você salvaria e carregaria o token
    // Por enquanto, assumimos que o usuário já autenticou
    if (process.env.GOOGLE_CALENDAR_TOKEN) {
      const token = JSON.parse(process.env.GOOGLE_CALENDAR_TOKEN);
      oAuth2Client.setCredentials(token);
    }

    return oAuth2Client;
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

      // Primeiro, vamos buscar o evento para confirmar que existe
      try {
        const eventResponse = await calendar.events.get({
          calendarId: 'primary',
          eventId: args.eventId,
        });
        
        const eventTitle = eventResponse.data.summary;
        
        // Agora deletamos o evento
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

      // Primeiro, buscamos o evento atual
      const currentEvent = await calendar.events.get({
        calendarId: 'primary',
        eventId: args.eventId,
      });

      // Criamos o evento atualizado, mantendo os valores atuais se não fornecidos
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
    const server = http.createServer((req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Google Calendar MCP Server</title>
            <meta charset="utf-8">
            <style>
              body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; }
              .container { background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
              .status { color: #4CAF50; font-weight: bold; }
              .tool { background: #f8f9fa; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 4px solid #007bff; }
              .tool-name { font-weight: bold; color: #007bff; }
              .tool-desc { color: #666; margin-top: 5px; }
              h1 { color: #333; }
              .emoji { font-size: 1.2em; }
            </style>
          </head>
          <body>
            <div class="container">
              <h1><span class="emoji">📅</span> Google Calendar MCP Server</h1>
              
              <p><span class="emoji">✅</span> <span class="status">Servidor rodando com sucesso!</span></p>
              <p><span class="emoji">🔗</span> <strong>URL do servidor:</strong> ${req.headers.host}</p>
              <p><span class="emoji">📊</span> <strong>Status:</strong> <span class="status">Online</span></p>
              
              <h2><span class="emoji">🛠️</span> Ferramentas disponíveis:</h2>
              
              <div class="tool">
                <div class="tool-name">get_auth_url</div>
                <div class="tool-desc">Obter URL de autenticação</div>
              </div>
              
              <div class="tool">
                <div class="tool-name">list_events</div>
                <div class="tool-desc">Listar eventos</div>
              </div>
              
              <div class="tool">
                <div class="tool-name">create_event</div>
                <div class="tool-desc">Criar evento</div>
              </div>
              
              <div class="tool">
                <div class="tool-name">delete_event</div>
                <div class="tool-desc">Deletar evento</div>
              </div>
              
              <div class="tool">
                <div class="tool-name">update_event</div>
                <div class="tool-desc">Atualizar evento</div>
              </div>
              
              <p style="margin-top: 30px; color: #666;">
                <span class="emoji">💡</span> Para usar este servidor, configure-o como um MCP server no Claude Desktop
              </p>
            </div>
          </body>
          </html>
        `);
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    const port = process.env.PORT || 10000;
    server.listen(port, () => {
      console.log(`🚀 Servidor HTTP rodando na porta ${port}`);
    });
  }
}

const server = new GoogleCalendarServer();
server.run().catch(console.error);
