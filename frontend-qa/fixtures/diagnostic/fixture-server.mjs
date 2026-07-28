import http from "node:http";

const portIndex = process.argv.indexOf("--port");
const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 4179;

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Frontend QA Diagnostic Fixture</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 24px; }
      .overflow { width: 1600px; height: 24px; background: #d33; }
    </style>
  </head>
  <body>
    <h1>Frontend QA Diagnostic Fixture</h1>
    <p>Supercharge your workflow with our all-in-one platform.</p>
    <button></button>
    <input name="diagnostic-input">
    <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
    <div class="overflow">Intentional horizontal overflow</div>
    <script>console.error("intentional frontend qa fixture error");</script>
  </body>
</html>`;

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`fixture ready at http://127.0.0.1:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
