import { eventHandler } from "h3";

export default eventHandler(() => {
  return `
    <meta charset="utf-8">
    <style>
      body { font-family: system-ui, sans-serif; margin: 3rem auto; max-width: 640px; line-height: 1.5; }
      code { background: #f4f4f5; padding: 0.15rem 0.35rem; border-radius: 0.25rem; }
    </style>
    <h1>Treehouse workers</h1>
    <p>Background jobs for Treehouse, run on BullMQ.</p>
    <p>The queue dashboard is at <code>/admin/queues</code> (basic auth required).</p>
  `;
});