// A stand-in for DPAPI in tests (PLAN-46 T-217): reversible, marked, and the plain text never
// appears in the sealed bytes. The real DPAPI round trip has its own test on Windows.
export const testProtector = {
  protect: async (plain) => Buffer.concat([Buffer.from('SEALED'), plain.map((b) => b ^ 0x5a)]),
  unprotect: async (sealed) => {
    if (sealed.subarray(0, 6).toString() !== 'SEALED') throw Error('not sealed by the test');
    return sealed.subarray(6).map((b) => b ^ 0x5a);
  },
};
