// Plugin de prueba (PL1): veta `terraform destroy` y anota la salida de `probe`.
export default {
  id: 'guard-env',
  apiVersion: 1,
  setup(stratum, options) {
    stratum.on('tool.before', (call) => {
      if (call.tool === 'exec' && /\bterraform\s+destroy\b/.test(String(call.input.command))) {
        return { block: true, reason: 'terraform destroy is not allowed from the agent.' };
      }
      return undefined;
    });
    stratum.on('tool.after', (result) => {
      if (result.tool === 'probe' && result.ok) {
        return { output: `${result.output}\n[${options.tag ?? 'guard-env'}]` };
      }
      return undefined;
    });
  },
};
