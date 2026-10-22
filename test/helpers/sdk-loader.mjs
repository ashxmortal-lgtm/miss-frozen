export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'sdk') {
    return { url: new URL('./sdk_stub.mjs', import.meta.url).href, shortCircuit: true };
  }
  if (specifier === 'sdk/db') {
    return { url: new URL('./sdk_db_stub.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
