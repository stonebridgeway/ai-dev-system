import http from "node:http";

const portIndex = process.argv.indexOf("--port");
const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 4181;

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Frontend QA Healthy Fixture</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        color: #17202a;
        background: #f4f7f9;
        font-family: Arial, sans-serif;
      }
      main {
        width: min(100% - 32px, 760px);
        margin: 48px auto;
        padding: 32px;
        background: #fff;
        border: 1px solid #d8e0e7;
      }
      label { display: block; margin: 20px 0 6px; }
      input { width: 100%; min-height: 42px; padding: 8px 10px; }
      button { min-height: 42px; margin-top: 16px; padding: 8px 16px; }
      #status { min-height: 24px; margin-top: 16px; }
      @media (max-width: 520px) {
        main { margin: 20px auto; padding: 20px; }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Frontend QA fixture</h1>
      <p>Stable page for browser, accessibility, interaction, and visual checks.</p>
      <label for="name">Name</label>
      <input id="name" name="name" autocomplete="name">
      <button id="submit" type="button">Confirm</button>
      <p id="status" aria-live="polite">Waiting</p>
    </main>
    <script>
      document.querySelector("#submit").addEventListener("click", () => {
        const name = document.querySelector("#name").value.trim() || "Guest";
        document.querySelector("#status").textContent = "Confirmed: " + name;
      });
    </script>
  </body>
</html>`;

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`healthy fixture ready at http://127.0.0.1:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
