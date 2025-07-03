const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Google OAuth2 configuration
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || `${process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000'}/auth/callback`
);

// Calendar API instance
const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// Store tokens (in production, use a proper database)
let tokenStore = {};

// ===========================================
// OpenAI MCP Compatible Endpoints
// ===========================================

// MCP Discovery endpoint - lists all available tools
app.get('/tools/list', async (req, res) => {
  try {
    const tools = [
      {
        name: 'list_calendar_events',
        description: 'List events from Google Calendar with optional date filtering',
        inputSchema: {
          type: 'object',
          properties: {
            timeMin: {
              type: 'string',
              description: 'Start time for events (ISO 8601 format, e.g., 2024-01-01T00:00:00Z)'
            },
            timeMax: {
              type: 'string', 
              description: 'End time for events (ISO 8601 format, e.g., 2024-12-31T23:59:59Z)'
            },
            maxResults: {
              type: 'integer',
              description: 'Maximum number of events to return (default: 10)',
              default: 10
            },
            singleEvents: {
              type: 'boolean',
              description: 'Whether to expand recurring events (default: true)',
              default: true
            }
          }
        }
      },
      {
        name: 'create_calendar_event',
        description: 'Create a new event in Google Calendar',
        inputSchema: {
          type: 'object',
          properties: {
            summary: {
              type: 'string',
              description: 'Event title/summary'
            },
            description: {
              type: 'string',
              description: 'Event description (optional)'
            },
            start: {
              type: 'object',
              properties: {
                dateTime: {
                  type: 'string',
                  description: 'Start date and time (ISO 8601 format)'
                },
                timeZone: {
                  type: 'string',
                  description: 'Time zone (default: America/Sao_Paulo)',
                  default: 'America/Sao_Paulo'
                }
              },
              required: ['dateTime']
            },
            end: {
              type: 'object',
              properties: {
                dateTime: {
                  type: 'string',
                  description: 'End date and time (ISO 8601 format)'
                },
                timeZone: {
                  type: 'string',
                  description: 'Time zone (default: America/Sao_Paulo)',
                  default: 'America/Sao_Paulo'
                }
              },
              required: ['dateTime']
            },
            attendees: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  email: { type: 'string' }
                }
              },
              description: 'List of attendee emails (optional)'
            },
            location: {
              type: 'string',
              description: 'Event location (optional)'
            }
          },
          required: ['summary', 'start', 'end']
        }
      },
      {
        name: 'update_calendar_event',
        description: 'Update an existing event in Google Calendar',
        inputSchema: {
          type: 'object',
          properties: {
            eventId: {
              type: 'string',
              description: 'The ID of the event to update'
            },
            summary: {
              type: 'string', 
              description: 'Event title/summary'
            },
            description: {
              type: 'string',
              description: 'Event description'
            },
            start: {
              type: 'object',
              properties: {
                dateTime: { type: 'string' },
                timeZone: { type: 'string', default: 'America/Sao_Paulo' }
              }
            },
            end: {
              type: 'object', 
              properties: {
                dateTime: { type: 'string' },
                timeZone: { type: 'string', default: 'America/Sao_Paulo' }
              }
            },
            location: {
              type: 'string',
              description: 'Event location'
            }
          },
          required: ['eventId']
        }
      },
      {
        name: 'delete_calendar_event',
        description: 'Delete an event from Google Calendar',
        inputSchema: {
          type: 'object',
          properties: {
            eventId: {
              type: 'string',
              description: 'The ID of the event to delete'
            }
          },
          required: ['eventId']
        }
      }
    ];

    res.json({ tools });
  } catch (error) {
    console.error('Error listing tools:', error);
    res.status(500).json({ error: 'Failed to list tools' });
  }
});

// MCP Tool execution endpoint
app.post('/tools/call', async (req, res) => {
  try {
    const { name, arguments: args } = req.body;

    // Check if user is authenticated
    if (!tokenStore.access_token) {
      return res.status(401).json({ 
        error: 'Not authenticated. Please visit /auth/url to authenticate first.' 
      });
    }

    // Set tokens
    oauth2Client.setCredentials({
      access_token: tokenStore.access_token,
      refresh_token: tokenStore.refresh_token
    });

    let result;

    switch (name) {
      case 'list_calendar_events':
        result = await listCalendarEvents(args);
        break;
      case 'create_calendar_event':
        result = await createCalendarEvent(args);
        break;
      case 'update_calendar_event':
        result = await updateCalendarEvent(args);
        break;
      case 'delete_calendar_event':
        result = await deleteCalendarEvent(args);
        break;
      default:
        return res.status(400).json({ error: `Unknown tool: ${name}` });
    }

    res.json({ 
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    });

  } catch (error) {
    console.error('Error calling tool:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===========================================
// Tool Implementation Functions
// ===========================================

async function listCalendarEvents(args = {}) {
  const params = {
    calendarId: 'primary',
    timeMin: args.timeMin || new Date().toISOString(),
    timeMax: args.timeMax,
    maxResults: args.maxResults || 10,
    singleEvents: args.singleEvents !== false,
    orderBy: 'startTime'
  };

  const response = await calendar.events.list(params);
  
  const events = response.data.items?.map(event => ({
    id: event.id,
    summary: event.summary,
    description: event.description,
    start: event.start?.dateTime || event.start?.date,
    end: event.end?.dateTime || event.end?.date,
    location: event.location,
    attendees: event.attendees?.map(a => a.email),
    htmlLink: event.htmlLink,
    status: event.status
  })) || [];

  return {
    success: true,
    events,
    total: events.length,
    message: `Found ${events.length} events`
  };
}

async function createCalendarEvent(args) {
  const event = {
    summary: args.summary,
    description: args.description,
    start: {
      dateTime: args.start.dateTime,
      timeZone: args.start.timeZone || 'America/Sao_Paulo'
    },
    end: {
      dateTime: args.end.dateTime,
      timeZone: args.end.timeZone || 'America/Sao_Paulo'
    },
    location: args.location,
    attendees: args.attendees?.map(email => ({ email }))
  };

  const response = await calendar.events.insert({
    calendarId: 'primary',
    resource: event
  });

  return {
    success: true,
    event: {
      id: response.data.id,
      summary: response.data.summary,
      start: response.data.start,
      end: response.data.end,
      htmlLink: response.data.htmlLink
    },
    message: 'Event created successfully'
  };
}

async function updateCalendarEvent(args) {
  const eventId = args.eventId;
  delete args.eventId;

  // Get current event data first
  const currentEvent = await calendar.events.get({
    calendarId: 'primary',
    eventId: eventId
  });

  // Merge current data with updates
  const updatedEvent = {
    ...currentEvent.data,
    ...args
  };

  const response = await calendar.events.update({
    calendarId: 'primary',
    eventId: eventId,
    resource: updatedEvent
  });

  return {
    success: true,
    event: {
      id: response.data.id,
      summary: response.data.summary,
      start: response.data.start,
      end: response.data.end,
      htmlLink: response.data.htmlLink
    },
    message: 'Event updated successfully'
  };
}

async function deleteCalendarEvent(args) {
  await calendar.events.delete({
    calendarId: 'primary',
    eventId: args.eventId
  });

  return {
    success: true,
    eventId: args.eventId,
    message: 'Event deleted successfully'
  };
}

// ===========================================
// Authentication Endpoints (unchanged)
// ===========================================

app.get('/auth/url', (req, res) => {
  const scopes = ['https://www.googleapis.com/auth/calendar'];
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent'
  });

  res.json({
    auth_url: authUrl,
    redirect_uri: oauth2Client.redirectUri,
    instructions: 'Acesse a auth_url no navegador, faça login e autorize o acesso'
  });
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send('Authorization code missing');
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    tokenStore = tokens;
    oauth2Client.setCredentials(tokens);

    res.send(`
      <h2>✅ Authentication Successful!</h2>
      <p>Your Google Calendar API is now authenticated and ready to use.</p>
      <p><strong>Your server is ready for OpenAI MCP integration!</strong></p>
      <h3>MCP Endpoints:</h3>
      <ul>
        <li><strong>Tools List:</strong> GET /tools/list</li>
        <li><strong>Tool Execution:</strong> POST /tools/call</li>
      </ul>
      <p>You can now use this server with OpenAI's Responses API MCP tool.</p>
    `);
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).send('Authentication failed');
  }
});

app.get('/auth/status', (req, res) => {
  res.json({
    authenticated: !!tokenStore.access_token,
    method: 'OAuth 2.0'
  });
});

// ===========================================
// Health Check and Documentation
// ===========================================

app.get('/', (req, res) => {
  res.json({
    name: 'Google Calendar MCP Server - OpenAI Compatible',
    version: '2.0.0',
    description: 'OpenAI MCP compatible Google Calendar API server',
    status: tokenStore.access_token ? 'authenticated' : 'not_authenticated',
    mcp_endpoints: {
      'GET /tools/list': 'List all available MCP tools',
      'POST /tools/call': 'Execute MCP tools'
    },
    auth_endpoints: {
      'GET /auth/url': 'Get OAuth authentication URL',
      'GET /auth/callback': 'OAuth callback (used by Google)',
      'GET /auth/status': 'Check authentication status'
    },
    usage: {
      step1: 'Visit /auth/url to authenticate with Google',
      step2: 'Use /tools/list to see available tools',
      step3: 'Use /tools/call to execute tools',
      openai_integration: 'Use this server URL in OpenAI Responses API MCP tool configuration'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    authenticated: !!tokenStore.access_token
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 OpenAI MCP Compatible Google Calendar Server running on port ${PORT}`);
  console.log(`📚 Documentation: http://localhost:${PORT}`);
  console.log(`🔧 MCP Tools List: http://localhost:${PORT}/tools/list`);
  console.log(`🔑 Authentication: http://localhost:${PORT}/auth/url`);
});
