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
import { OAuth2Client } from 'google-auth-library';
import fs from 'fs/promises';
import path from 'path';
import http from 'http';
import url from 'url';

class GoogleCalendarServer {
  constructor() {
    this.server = new Server(
      {
        name: 'google-calendar-mcp',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.oauth2Client = null;
    this.calendar = null;
    this.setupToolHandlers();
    
    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  async initializeAuth() {
    try {
      // Tenta ler credenciais da variável de ambiente primeiro
      let credentials;
      
      if (process.env.GOOGLE_CALENDAR_CREDENTIALS) {
        console.log('📱 Lendo credenciais da variável de ambiente...');
        credentials = JSON.parse(process.env.GOOGLE_CALENDAR_CREDENTIALS);
      } else {
        // Fallback para arquivo (para desenvolvimento local)
        console.log('📁 Lendo credenciais do arquivo...');
        const credentialsPath = path.join(process.cwd(), 'gcp-oauth-keys.json');
        const credentialsContent = await fs.readFile(credentialsPath, 'utf8');
        credentials = JSON.parse(credentialsContent);
      }

      const { client_id, client_secret, redirect_uris } = credentials.web || credentials.installed;
      
      this.oauth2Client = new OAuth2Client(
        client_id,
        client_secret,
        redirect_uris[0]
      );

      // Tenta carregar token salvo
      await this.loadTokens();
      
      this.calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
      
      console.log('✅ Autenticação inicializada com sucesso!');
    } catch (error) {
      console.error('❌ Erro ao inicializar autenticação:', error.message);
      throw error;
    }
  }

  async loadTokens() {
    try {
      const tokenPath = process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH || '/tmp/tokens.json';
      
      // Tenta ler tokens salvos
      try {
        const tokensContent = await fs.readFile(tokenPath, 'utf8');
        const tokens = JSON.parse(tokensContent);
        this.oauth2Client.setCredentials(tokens);
        console.log('🔑 Tokens carregados com sucesso');
      } catch (error) {
        console.log('⚠️  Nenhum token salvo encontrado. Será necessário autenticar.');
      }
    } catch (error) {
      console.error('❌ Erro ao carregar tokens:', error.message);
    }
  }

  async saveTokens(tokens) {
    try {
      const tokenPath = process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH || '/tmp/tokens.json';
      await fs.writeFile(tokenPath, JSON.stringify(tokens, null, 2));
      console.log('💾 Tokens salvos com sucesso');
    } catch (error) {
      console.error('❌ Erro ao salvar tokens:', error.message);
    }
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'list_events',
          description: 'Lista eventos do Google Calendar',
          inputSchema: {
            type: 'object',
            properties: {
              timeMin: {
                type: 'string',
                description: 'Data/hora mínima (ISO 8601)',
              },
              timeMax: {
                type: 'string',
                description: 'Data/hora máxima (ISO 8601)',
              },
              maxResults: {
                type: 'number',
                description: 'Número máximo de eventos (padrão: 10)',
                default: 10,
              },
            },
          },
        },
        {
          name: 'create_event',
          description: 'Cria um novo evento no Google Calendar',
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
            },
            required: ['summary', 'start', 'end'],
          },
        },
        {
          name: 'get_auth_url',
          description: 'Obtém URL para autenticação OAuth',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'get_auth_url':
            return await this.getAuthUrl();

          case 'list_events':
            return await this.listEvents(args);

          case 'create_event':
            return await this.createEvent(args);

          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Ferramenta desconhecida: ${name}`
            );
        }
      } catch (error) {
        if (error.code === 401) {
          return {
            content: [
              {
                type: 'text',
                text: `❌ Erro de autenticação. Use a ferramenta 'get_auth_url' para obter o link de autenticação.\n\nErro: ${error.message}`,
              },
            ],
          };
        }
        
        throw new McpError(
          ErrorCode.InternalError,
          `Erro na ferramenta ${name}: ${error.message}`
        );
      }
    });
  }

  async getAuthUrl() {
    const scopes = ['https://www.googleapis.com/auth/calendar'];
    
    const authUrl = this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent',
    });

    return {
      content: [
        {
          type: 'text',
          text: `🔗 **Link de Autenticação Google Calendar:**\n\n${authUrl}\n\n📝 **Instruções:**\n1. Clique no link acima\n2. Faça login na sua conta Google\n3. Autorize o acesso ao Calendar\n4. Copie o código de autorização\n5. Use esse código para completar a autenticação`,
        },
      ],
    };
  }

  async listEvents(args = {}) {
    const {
      timeMin = new Date().toISOString(),
      timeMax,
      maxResults = 10,
    } = args;

    const response = await this.calendar.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      maxResults,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = response.data.items || [];
    
    if (events.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: '📅 Nenhum evento encontrado no período especificado.',
          },
        ],
      };
    }

    const eventList = events.map((event, index) => {
      const start = event.start?.dateTime || event.start?.date;
      const end = event.end?.dateTime || event.end?.date;
      
      return `${index + 1}. **${event.summary || 'Sem título'}**
   📅 Início: ${new Date(start).toLocaleString('pt-BR')}
   ⏰ Fim: ${new Date(end).toLocaleString('pt-BR')}
   📝 Descrição: ${event.description || 'Nenhuma'}
   🔗 Link: ${event.htmlLink || 'N/A'}`;
    }).join('\n\n');

    return {
      content: [
        {
          type: 'text',
          text: `📅 **Eventos encontrados (${events.length}):**\n\n${eventList}`,
        },
      ],
    };
  }

  async createEvent(args) {
    const { summary, description, start, end } = args;

    const event = {
      summary,
      description,
      start: {
        dateTime: start,
        timeZone: 'America/Sao_Paulo',
      },
      end: {
        dateTime: end,
        timeZone: 'America/Sao_Paulo',
      },
    };

    const response = await this.calendar.events.insert({
      calendarId: 'primary',
      resource: event,
    });

    return {
      content: [
        {
          type: 'text',
          text: `✅ **Evento criado com sucesso!**

📅 **Título:** ${response.data.summary}
🗓️ **Início:** ${new Date(response.data.start.dateTime).toLocaleString('pt-BR')}
⏰ **Fim:** ${new Date(response.data.end.dateTime).toLocaleString('pt-BR')}
🔗 **Link:** ${response.data.htmlLink}
🆔 **ID:** ${response.data.id}`,
        },
      ],
    };
  }

  async run() {
    // Para ambiente web/HTTP
    if (process.env.PORT || process.env.NODE_ENV === 'production') {
      console.log('🌐 Iniciando servidor HTTP...');
      await this.initializeAuth();
      this.startHttpServer();
    } else {
      // Para ambiente MCP local
      console.log('🔌 Iniciando servidor MCP (stdio)...');
      await this.initializeAuth();
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
    }
  }

  startHttpServer() {
    const port = process.env.PORT || 3000;
    
    const server = http.createServer(async (req, res) => {
      const parsedUrl = url.parse(req.url, true);
      
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      
      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      if (req.method === 'GET' && parsedUrl.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Google Calendar MCP</title>
            <meta charset="utf-8">
          </head>
          <body>
            <h1>🗓️ Google Calendar MCP Server</h1>
            <p>✅ Servidor rodando com sucesso!</p>
            <p>🔗 <strong>URL do servidor:</strong> ${req.headers.host}</p>
            <p>📝 <strong>Status:</strong> Online</p>
            <hr>
            <h3>🛠️ Ferramentas disponíveis:</h3>
            <ul>
              <li><code>get_auth_url</code> - Obter URL de autenticação</li>
              <li><code>list_events</code> - Listar eventos</li>
              <li><code>create_event</code> - Criar evento</li>
            </ul>
            <hr>
            <p><small>Para usar este servidor, configure-o como um MCP server no Claude Desktop.</small></p>
          </body>
          </html>
        `);
        return;
      }

      if (req.method === 'GET' && parsedUrl.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          status: 'ok', 
          service: 'google-calendar-mcp',
          timestamp: new Date().toISOString()
        }));
        return;
      }

      // 404 para outras rotas
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 - Página não encontrada');
    });

    server.listen(port, '0.0.0.0', () => {
      console.log(`🚀 Servidor HTTP rodando na porta ${port}`);
      console.log(`🌐 URL: http://localhost:${port}`);
      console.log(`📡 Render URL: https://google-calendar-mcp-server.onrender.com`);
    });
  }
}

// Inicia o servidor
const server = new GoogleCalendarServer();
server.run().catch(console.error);
