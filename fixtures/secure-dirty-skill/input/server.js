// Intentionally vulnerable server for HMA testing
const express = require('express');
const app = express();

// No input validation
app.post('/api/query', (req, res) => {
  const query = req.body.query;
  // SQL injection vulnerable
  const sql = `SELECT * FROM users WHERE name = '${query}'`;
  res.json({ sql });
});

// Path traversal vulnerable
app.get('/files/:path', (req, res) => {
  const filePath = req.params.path;
  res.sendFile(filePath); // No sanitization
});

// Debug endpoint exposed
app.get('/debug', (req, res) => {
  res.json({ env: process.env, memory: process.memoryUsage() });
});

// Admin endpoint with no auth
app.get('/admin', (req, res) => {
  res.json({ status: 'admin panel', users: ['admin'] });
});

// WebSocket without auth
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8081 });
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    // No authentication check
    ws.send(`Echo: ${data}`);
  });
});

// API key in query param
app.get('/api/data', (req, res) => {
  const apiKey = req.query.api_key;
  res.json({ data: 'sensitive', key: apiKey });
});

// File upload without validation
app.post('/upload', (req, res) => {
  // Accept any file type, any size
  res.json({ status: 'uploaded' });
});

app.listen(8080, '0.0.0.0', () => {
  console.log('Server running on 0.0.0.0:8080');
});
