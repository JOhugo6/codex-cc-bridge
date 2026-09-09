'use strict';
const { diagnostic, failureDiagnostic, emit } = require('./ci-diagnostics');

async function main(makeFixture = () => require('./native-contract-fixture').fixture(), write = emit) {
  let fixture, failed = false;
  try {
    fixture = await makeFixture();
    await fixture.verifyCompatibility(value => write(value));
  } catch (error) {
    failed = true;
    write(failureDiagnostic(error));
  } finally {
    if (fixture) {
      try { await fixture.close(); }
      catch {
        failed = true;
        write(diagnostic('cleanup', { code: 'UNKNOWN' }));
      }
    }
  }
  return failed ? 1 : 0;
}
if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(() => {
    emit(diagnostic('unknown', { code: 'UNKNOWN' }));
    process.exitCode = 1;
  });
}
module.exports = { main };
