# Google Calendar MCP Server

Servidor MCP (Model Context Protocol) para integração do Google Calendar com Claude Desktop.

## 🚀 Deploy no Render

Este servidor está configurado para rodar no Render.com gratuitamente.

### Configuração:

1. **Variáveis de Ambiente Necessárias:**
   - `GOOGLE_CALENDAR_CREDENTIALS`: JSON com credenciais OAuth2 do Google Cloud
   - `PORT`: 10000 (automático no Render)

2. **Comandos:**
   - Build: `npm install`
   - Start: `npm start`

### Credenciais Google:

1. Acesse [Google Cloud Console](https://console.cloud.google.com)
2. Crie um projeto novo
3. Ative a Google Calendar API
4. Crie credenciais OAuth2 (Web Application)
5. Configure redirect URI: `https://your-app.onrender.com/auth/callback`
6. Baixe o JSON e adicione como variável de ambiente

## 🛠️ Ferramentas Disponíveis:

- `get_auth_url` - Obter URL de autenticação OAuth
- `list_events` - Listar eventos do calendário
- `create_event` - Criar novos eventos

## 📡 Uso:

Após deploy, configure no Claude Desktop MCP:

```json
{
  "mcpServers": {
    "google-calendar": {
      "command": "node",
      "args": ["/path/to/index.js"],
      "env": {
        "GOOGLE_CALENDAR_CREDENTIALS": "..."
      }
    }
  }
}
```

## 🌐 Status:

- ✅ Servidor HTTP para Render
- ✅ Suporte a variáveis de ambiente
- ✅ Fallback para arquivos locais
- ✅ Logs detalhados
