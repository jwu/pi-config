// Activate the built-in grep, find, and ls tools (defined but not active by default).
// Place this file in ~/.pi/agent/extensions/ or load with: pi -e <path>

export default function (pi: {
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}) {
  // const active = pi.getActiveTools();
  // pi.setActiveTools([...active, 'grep', 'find', 'ls']);
  pi.setActiveTools(['bash', 'edit', 'write', 'read', 'grep', 'find', 'ls']);
}
