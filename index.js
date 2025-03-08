const SchwabAuth = require('./schwabAuth');

async function main() {
  const auth = new SchwabAuth();
  await auth.init();
  process.exit();
}

main().catch(console.error); 