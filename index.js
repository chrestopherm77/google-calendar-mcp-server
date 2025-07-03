const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Google OAuth2 configuration
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || `${process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000'}/auth/callback`
);

// Calendar API instance
const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// Store tokens globally (authenticated once for the server)
let serverTokens = {};
let isAuthenticated = false;

// ===========================================
// OpenAI MCP Compatible Endpoints
// ===========================================

// MCP Tools List endpoint - OpenAI calls this to discover available tools
app.post('/tools/list', async (req, res) => {
  try {
    // Check server authentication
    if (!isAuthenticated) {
      return res.status(401).json({ 
        error: 'Server not authenticated. Administrator must authenticate first at /auth/url' 
      });
    }

    const tools = [
      {
        name: 'list_calendar_events',
        description: 'List events from Google Calendar with optional date filtering. Returns events in chronological order.',
        inputSchema: {
          type: 'object',
          properties: {
            timeMin: {
              type: 'string',
              description: 'Start time for events in ISO 8601 format (e.g., 2024-01-01T00:00:00Z). Defaults to current time.'
            },
            timeMax: {
              type: 'string', 
              description: 'End time for events in ISO 8601 format (e.g., 2024-12-31T23:59:59Z). Optional.'
            },
            maxResults: {
              type: 'integer',
              description: 'Maximum number of events to return. Default: 10, Max: 50',
              minimum: 1,
              maximum: 50,
              default: 10
            },
            singleEvents: {
              type: 'boolean',
              description: 'Whether to expand recurring events into individual instances. Default: true',
              default: true
            }
          },
          additionalProperties: false
        }
      },
      {
        name: 'create_calendar_event',
        description: 'Create a new event in Google Calendar. All times should be in ISO 8601 format.',
        inputSchema: {
          type: 'object',
          properties: {
            summary: {
              type: 'string',
              description: 'Event title/summary (required)',
              minLength: 1,
              maxLength: 255
            },
            description: {
              type: 'string',
              description: 'Event description (optional)',
              maxLength: 8192
            },
            start: {
              type: 'object',
              properties: {
                dateTime: {
                  type: 'string',
                  description: 'Start date and time in ISO 8601 format (e.g., 2024-01-01T10:00:00-03:00)'
                },
                timeZone: {
                  type: 'string',
                  description: 'Time zone identifier (e.g., America/Sao_Paulo). Default: America/Sao_Paulo',
                  default: 'America/Sao_Paulo'
                }
              },
              required: ['dateTime'],
              additionalProperties: false
            },
            end: {
              type: 'object',
              properties: {
                dateTime: {
                  type: 'string',
                  description: 'End date and time in ISO 8601 format (e.g., 2024-01-01T11:00:00-03:00)'
                },
                timeZone: {
                  type: 'string',
                  description: 'Time zone identifier (e.g., America/Sao_Paulo). Default: America/Sao_Paulo',
                  default: 'America/Sao_Paulo'
                }
              },
              required: ['dateTime'],
              additionalProperties: false
            },
            attendees: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  email: { 
                    type: 'string',
                    format: 'email'
                  }
                },
                required: ['email'],
                additionalProperties: false
              },
              description: 'List of attendee email addresses (optional)',
              maxItems: 100
            },
            location: {
              type: 'string',
              description: 'Event location (optional)',
              maxLength: 255
            }
          },
          required: ['summary', 'start', 'end'],
          additionalProperties: false
        }
      },
      {
        name: 'update_calendar_event',
        description: 'Update an existing event in Google Calendar. Only provided fields will be updated.',
        inputSchema: {
          type: 'object',
          properties: {
            eventId: {
              type: 'string',
              description: 'The ID of the event to update (required)',
              minLength: 1
            },
            summary: {
              type: 'string', 
              description: 'New event title/summary',
              minLength: 1,
              maxLength: 255
            },
            description: {
              type: 'string',
              description: 'New event description',
              maxLength: 8192
            },
            start: {
              type: 'object',
              properties: {
                dateTime: { 
                  type: 'string',
                  description: 'New start date and time in ISO 8601 format'
                },
                timeZone: { 
                  type: 'string', 
                  default: 'America/Sao_Paulo',
                  description: 'Time zone identifier'
                }
              },
              additionalProperties: false
            },
            end: {
              type: 'object', 
              properties: {
                dateTime: { 
                  type: 'string',
                  description: 'New end date and time in ISO 8601 format'
                },
                timeZone: { 
                  type: 'string', 
                  default: 'America/Sao_Paulo',
                  description: 'Time zone identifier'
                }
              },
              additionalProperties: false
            },
            location: {
              type: 'string',
              description: 'New event location',
              maxLength: 255
            }
          },
          required: ['eventId'],
          additionalProperties: false
        }
      },
      {
        name: 'delete_calendar_event',
        description: 'Delete an event from Google Calendar. This action cannot be undone.',
        inputSchema: {
          type: 'object',
          properties: {
            eventId: {
              type: 'string',
              description: 'The ID of the event to delete (required)',
              minLength: 1
            }
          },
          required: ['eventId'],
          additionalProperties: false
        }
      }
    ];

    res.json({ tools });
  } catch (error) {
    console.error('Error listing tools:', error);
    res.status(500).json({ error: 'Failed to list tools', details: error.message });
  }
});

// MCP Tool execution endpoint - OpenAI calls this to execute tools
app.post('/tools/call', async (req, res) => {
  try {
    const { name, arguments: args = {} } = req.body;

    // Validate request format
    if (!name) {
      return res.status(400).json({ 
        error: 'Missing required field: name' 
      });
    }

    // Check server authentication
    if (!isAuthenticated) {
      return res.status(401).json({ 
        error: 'Server not authenticated. Administrator must authenticate first.' 
      });
    }

    // Set credentials for this request
    oauth2Client.setCredentials(serverTokens);

    let result;

    try {
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
          return res.status(400).json({ 
            error: `Unknown tool: ${name}`,
            available_tools: ['list_calendar_events', 'create_calendar_event', 'update_calendar_event', 'delete_calendar_event']
          });
      }

      // OpenAI MCP expects specific response format
      res.json({ 
        content: [
          {
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
          }
        ]
      });

    } catch (toolError) {
      console.error(`Error executing tool ${name}:`, toolError);
      
      // Return structured error response
      res.status(500).json({ 
        error: `Tool execution failed: ${toolError.message}`,
        tool: name,
        details: toolError.response?.data || toolError.stack
      });
    }

  } catch (error) {
    console.error('Error in tool call endpoint:', error);
    res.status(500).json({ 
      error: 'Internal server error', 
      details: error.message 
    });
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
    maxResults: Math.min(Math.max(args.maxResults || 10, 1), 50),
    singleEvents: args.singleEvents !== false,
    orderBy: 'startTime'
  };

  const response = await calendar.events.list(params);
  
  const events = response.data.items?.map(event => ({
    id: event.id,
    summary: event.summary || 'No title',
    description: event.description || '',
    start: event.start?.dateTime || event.start?.date,
    end: event.end?.dateTime || event.end?.date,
    location: event.location || '',
    attendees: event.attendees?.map(a => a.email) || [],
    htmlLink: event.htmlLink,
    status: event.status,
    created: event.created,
    updated: event.updated
  })) || [];

  return {
    success: true,
    events,
    total: events.length,
    message: `Found ${events.length} events`,
    timeRange: {
      start: params.timeMin,
      end: params.timeMax
    }
  };
}

async function createCalendarEvent(args) {
  // Validate required fields
  if (!args.summary || !args.start?.dateTime || !args.end?.dateTime) {
    throw new Error('Missing required fields: summary, start.dateTime, end.dateTime');
  }

  const event = {
    summary: args.summary,
    description: args.description || '',
    start: {
      dateTime: args.start.dateTime,
      timeZone: args.start.timeZone || 'America/Sao_Paulo'
    },
    end: {
      dateTime: args.end.dateTime,
      timeZone: args.end.timeZone || 'America/Sao_Paulo'
    },
    location: args.location || '',
    attendees: args.attendees?.map(attendee => ({ 
      email: attendee.email || attendee 
    })) || []
  };

  const response = await calendar.events.insert({
    calendarId: 'primary',
    resource: event,
    sendNotifications: true
  });

  return {
    success: true,
    event: {
      id: response.data.id,
      summary: response.data.summary,
      start: response.data.start,
      end: response.data.end,
      location: response.data.location,
      attendees: response.data.attendees?.map(a => a.email) || [],
      htmlLink: response.data.htmlLink,
      status: response.data.status
    },
    message: 'Event created successfully'
  };
}

async function updateCalendarEvent(args) {
  if (!args.eventId) {
    throw new Error('Missing required field: eventId');
  }

  try {
    // Get current event data first
    const currentEvent = await calendar.events.get({
      calendarId: 'primary',
      eventId: args.eventId
    });

    // Build update object with only provided fields
    const updateData = {};
    
    if (args.summary !== undefined) updateData.summary = args.summary;
    if (args.description !== undefined) updateData.description = args.description;
    if (args.location !== undefined) updateData.location = args.location;
    
    if (args.start) {
      updateData.start = {
        dateTime: args.start.dateTime,
        timeZone: args.start.timeZone || 'America/Sao_Paulo'
      };
    }
    
    if (args.end) {
      updateData.end = {
        dateTime: args.end.dateTime,
        timeZone: args.end.timeZone || 'America/Sao_Paulo'
      };
    }

    const response = await calendar.events.update({
      calendarId: 'primary',
      eventId: args.eventId,
      resource: updateData,
      sendNotifications: true
    });

    return {
      success: true,
      event: {
        id: response.data.id,
        summary: response.data.summary,
        start: response.data.start,
        end: response.data.end,
        location: response.data.location,
        attendees: response.data.attendees?.map(a => a.email) || [],
        htmlLink: response.data.htmlLink,
        status: response.data.status
      },
      message: 'Event updated successfully'
    };
  } catch (error) {
    if (error.code === 404) {
      throw new Error(`Event not found: ${args.eventId}`);
    }
    throw error;
  }
}

async function deleteCalendarEvent(args) {
  if (!args.eventId) {
    throw new Error('Missing required field: eventId');
  }

  try {
    // Get event details before deletion for confirmation
    const event = await calendar.events.get({
      calendarId: 'primary',
      eventId: args.eventId
    });

    await calendar.events.delete({
      calendarId: 'primary',
      eventId: args.eventId,
      sendNotifications: true
    });

    return {
      success: true,
      eventId: args.eventId,
      deletedEvent: {
        summary: event.data.summary,
        start: event.data.start,
        end: event.data.end
      },
      message: 'Event deleted successfully'
    };
  } catch (error) {
    if (error.code === 404) {
      throw new Error(`Event not found: ${args.eventId}`);
    }
    throw error;
  }
}

// ===========================================
// Server Authentication Endpoints
// ===========================================

app.get('/auth/url', (req, res) => {
  const scopes = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events'
  ];
  
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent'
  });

  res.json({
    auth_url: authUrl,
    instructions: 'Visit the auth_url in your browser and authorize the application to authenticate this MCP server',
    status: isAuthenticated ? 'already_authenticated' : 'not_authenticated'
  });
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send(`
      <h2>❌ Authentication Failed</h2>
      <p>Authorization code is missing.</p>
      <p><a href="/auth/url">Try again</a></p>
    `);
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    serverTokens = tokens;
    isAuthenticated = true;
    oauth2Client.setCredentials(tokens);

    // Test the authentication
    const testResponse = await calendar.calendarList.list();
    
    res.send(`
      <h2>✅ MCP Server Authentication Successful!</h2>
      <p><strong>Your Google Calendar MCP Server is now authenticated and ready!</strong></p>
      <p>Calendar access verified - found ${testResponse.data.items?.length || 0} calendars.</p>
      
      <h3>🔧 OpenAI Integration</h3>
      <p>Your MCP server is now ready to be used with OpenAI's Responses API.</p>
      <p><strong>Server URL:</strong> <code>${req.protocol}://${req.get('host')}</code></p>
      
      <h3>📋 Available Tools</h3>
      <ul>
        <li><strong>list_calendar_events</strong> - List calendar events</li>
        <li><strong>create_calendar_event</strong> - Create new events</li>
        <li><strong>update_calendar_event</strong> - Update existing events</li>
        <li><strong>delete_calendar_event</strong> - Delete events</li>
      </ul>
      
      <h3>🌐 MCP Endpoints</h3>
      <ul>
        <li><strong>POST /tools/list</strong> - Discover available tools</li>
        <li><strong>POST /tools/call</strong> - Execute tools</li>
      </ul>
      
      <p><em>This server will remain authenticated until restarted.</em></p>
    `);
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).send(`
      <h2>❌ Authentication Failed</h2>
      <p>Error: ${error.message}</p>
      <p><a href="/auth/url">Try again</a></p>
    `);
  }
});

app.get('/auth/status', (req, res) => {
  res.json({
    authenticated: isAuthenticated,
    method: 'OAuth 2.0',
    scopes: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events'
    ],
    server_ready: isAuthenticated
  });
});

// ===========================================
// Health Check and Documentation
// ===========================================

app.get('/', (req, res) => {
  res.json({
    name: 'Google Calendar MCP Server',
    version: '3.0.0',
    description: 'OpenAI MCP compatible Google Calendar API server',
    status: isAuthenticated ? 'authenticated_ready' : 'authentication_required', 
    server_url: `${req.protocol}://${req.get('host')}`,
    
    openai_mcp_endpoints: {
      'POST /tools/list': 'List all available MCP tools (OpenAI discovers tools)',
      'POST /tools/call': 'Execute MCP tools (OpenAI calls tools)'
    },
    
    auth_endpoints: {
      'GET /auth/url': 'Get OAuth authentication URL (server admin only)',
      'GET /auth/callback': 'OAuth callback (used by Google)',
      'GET /auth/status': 'Check server authentication status'
    },
    
    setup_instructions: {
      step1: 'Server admin visits /auth/url to authenticate with Google',
      step2: 'Add this server URL to OpenAI Responses API MCP configuration',
      step3: 'OpenAI will discover and use available calendar tools'
    },
    
    available_tools: isAuthenticated ? [
      'list_calendar_events',
      'create_calendar_event', 
      'update_calendar_event',
      'delete_calendar_event'
    ] : [],
    
    integration_notes: {
      authentication: 'Server-level authentication (admin configures once)',
      openai_usage: 'Add server URL to OpenAI Responses API tools configuration',
      security: 'No user authentication required - server handles Google Calendar access'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    authenticated: isAuthenticated,
    server_ready: isAuthenticated,
    version: '3.0.0'
  });
});

// Handle 404s
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    available_endpoints: [
      'GET /',
      'GET /health', 
      'GET /auth/url',
      'GET /auth/status',
      'POST /tools/list',
      'POST /tools/call'
    ]
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    error: 'Internal server error',
    message: error.message
  });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`🚀 Google Calendar MCP Server running on port ${PORT}`);
  console.log(`📚 Documentation: http://localhost:${PORT}`);
  console.log(`🔧 OpenAI MCP Tools: http://localhost:${PORT}/tools/list`);
  console.log(`🔑 Authentication: http://localhost:${PORT}/auth/url`);
  console.log(`📊 Health Check: http://localhost:${PORT}/health`);
  console.log(`⚠️  Server authentication required before use`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

module.exports = app;
