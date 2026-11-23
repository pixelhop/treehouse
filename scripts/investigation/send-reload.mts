import { sendIpc } from "../../packages/cli/src/ipc";
console.log(JSON.stringify(await sendIpc({ cmd: "reload" })));