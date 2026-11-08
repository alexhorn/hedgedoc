// Sentinel returned by key handlers to signal "not handled, let other bindings try".
// It keeps the contract of the former `CodeMirror.Pass` so that key handlers can stay unchanged.
export const Pass = { toString: () => 'Pass' }

export default Pass
