import { eventHandler } from "h3";

export default eventHandler(() => {
  return `
    <meta charset="utf-8">
    <style>
      body { font-family: system-ui, sans-serif; margin: 3rem auto; max-width: 640px; line-height: 1.4; }
      h1 { font-size: 1.75rem; margin-bottom: 0.5rem; }
    </style>
    <h1>Treehouse API</h1>
    <p>This is the API behind <a href="https://trytree.house">Treehouse</a>. See the <a href="https://trytree.house/docs">documentation</a>.</p>
  `;
});