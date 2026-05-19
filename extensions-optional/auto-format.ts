import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// Auto-format .ts files with prettier after edit/write tools
export default function (pi: ExtensionAPI) {
  pi.on('tool_result', async (event, _ctx) => {
    if (event.isError) return;
    if (event.toolName !== 'edit' && event.toolName !== 'write') return;

    const input = event.input as { path?: string } | undefined;
    const filePath = input?.path;
    if (!filePath || !filePath.endsWith('.ts')) return;

    await pi.exec('bun', ['prettier', '--write', filePath]);
  });
}
