const urlServer = 'http://127.0.0.1:8642/health';
const urlRelay = 'https://api.agentsquared.net/api/relay/health';

async function test() {
  console.log(`Testing fetch to Hermes health: ${urlServer}`);
  try {
    const res = await fetch(urlServer);
    console.log(`Hermes result: ${res.status} ${res.ok}`);
  } catch (e) {
    console.error(`Hermes fetch FAILED:`, e);
    if (e.cause) console.error(`Cause:`, e.cause);
  }

  console.log(`Testing fetch to Relay health: ${urlRelay}`);
  try {
    const res = await fetch(urlRelay);
    console.log(`Relay result: ${res.status} ${res.ok}`);
  } catch (e) {
    console.error(`Relay fetch FAILED:`, e);
    if (e.cause) console.error(`Cause:`, e.cause);
  }
}

test();
