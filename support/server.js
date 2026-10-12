const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3001;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.url === '/morning-brief-data.json') {
    const filePath = path.join('C:\\Users\\werne\\Documents\\werner-brain\\morning-brief-data.json');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'File not found' }));
      } else {
        res.writeHead(200);
        res.end(data);
      }
    });
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

server.listen(PORT, () => {
  console.log(`Morning Brief server running at http://localhost:${PORT}`);
  console.log(`Dashboard: open the artifact and it will fetch data from http://localhost:${PORT}/morning-brief-data.json`);
});
