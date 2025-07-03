# Google Calendar MCP Server

Servidor MCP (Model Context Protocol) para integração com Google Calendar, permitindo que o Claude Desktop gerencie eventos do seu calendário.

## 🚀 Funcionalidades

- ✅ Autenticação OAuth2 com Google
- 📅 Listar eventos do calendário
- ➕ Criar novos eventos
- ✏️ Atualizar eventos existentes
- 🗑️ Deletar eventos
- 🌐 Interface web para autenticação
- 🔄 Renovação automática de tokens

## 📋 Pré-requisitos

1. **Conta Google** com Google Calendar habilitado
2. **Projeto no Google Cloud Console**
3. **Credenciais OAuth2** configuradas
4. **Node.js 18+**

## ⚙️ Configuração do Google Cloud

1. Acesse o [Google Cloud Console](https://console.cloud.google.com)
2. Crie um novo projeto ou selecione um existente
3. Habilite a **Google Calendar API**
4. Crie credenciais OAuth 2.0:
   - Tipo: Web Application
   - Redirect URI: `https://seu-app.onrender.com/auth/callback`
5. Baixe o arquivo JSON das credenciais

## 🛠️ Instalação Local

```bash
# Clone o repositório
git clone https://github.com/seu-usuario/google-calendar-mcp-server.git
cd google-calendar-mcp-server

# Instale as dependências
npm install

# Configure as credenciais
# Coloque o arquivo JSON das credenciais como 'gcp-oauth-keys.json'

# Execute em modo desenvolvimento
npm run dev
```

## 🌐 Deploy no Render

1. **Fork este repositório**
2. **Conecte ao Render:**
   - Acesse [render.com](https://render.com)
   - Crie um novo Web Service
   - Conecte seu repositório GitHub

3. **Configure as variáveis de ambiente:**
   ```
   GOOGLE_CALENDAR_CREDENTIALS={"web":{"client_id":"...","client_secret":"...","redirect_uris":["https://seu-app.onrender.com/auth/callback"]}}
   NODE_ENV=production
   ```

4. **Configure o build:**
   - Build Command: `npm install`
   - Start Command: `npm start`

## 🔧 Configuração no Claude Desktop

Adicione ao seu `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "google-calendar": {
      "command": "node",
      "args": ["/caminho/para/index.js"],
      "env": {
        "NODE_ENV": "development"
      }
    }
  }
}
```

## 📝 Como Usar

1. **Autentique-se:**
   - Acesse a URL do seu servidor
   - Clique em "Autenticar com Google"
   - Autorize o acesso ao calendário

2. **No Claude Desktop, use comandos como:**
   - "Liste meus próximos eventos"
   - "Crie um evento para amanhã às 14h"
   - "Delete o evento com ID xyz"
   - "Atualize o evento para próxima semana"

## 🛠️ Ferramentas Disponíveis

- `get_auth_url` - Obter URL de autenticação
- `get_auth_status` - Verificar status da autenticação
- `list_events` - Listar eventos do calendário
- `create_event` - Criar novo evento
- `update_event` - Atualizar evento existente
- `delete_event` - Deletar evento

## 🔒 Segurança

- Tokens armazenados apenas em memória
- Renovação automática de tokens expirados
- CORS configurado adequadamente
- Credenciais via variáveis de ambiente

## 🐛 Troubleshooting

### Erro "Token expirado"
- Use `get_auth_url` para reautenticar

### Erro "Credenciais não encontradas"
- Verifique se a variável `GOOGLE_CALENDAR_CREDENTIALS` está configurada
- No desenvolvimento, certifique-se que `gcp-oauth-keys.json` existe

### Servidor não conecta
- Verifique se a porta está disponível
- Confirme se o NODE_ENV está configurado corretamente

## 📄 Licença

MIT License - veja o arquivo LICENSE para detalhes.
