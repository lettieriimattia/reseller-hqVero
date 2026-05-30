// Genera un certificato self-signed valido per LAN locale.
// Esegui: node scripts/generate-cert.js

const selfsigned = require('selfsigned');
const fs = require('fs');
const path = require('path');

const LOCAL_IP = '192.168.0.153';

async function main() {
  const attrs = [
    { name: 'commonName',       value: LOCAL_IP },
    { name: 'organizationName', value: 'ResellerHQ' },
    { name: 'countryName',      value: 'IT' },
  ];

  const pems = await selfsigned.generate(attrs, {
    algorithm: 'sha256',
    days: 825,
    keySize: 2048,
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
          { type: 7, ip: LOCAL_IP },
        ],
      },
      { name: 'basicConstraints', cA: false },
      {
        name: 'keyUsage',
        digitalSignature: true,
        keyEncipherment: true,
      },
      {
        name: 'extKeyUsage',
        serverAuth: true,
      },
    ],
  });

  const certsDir = path.join(__dirname, '..', 'certs');
  if (!fs.existsSync(certsDir)) fs.mkdirSync(certsDir, { recursive: true });

  fs.writeFileSync(path.join(certsDir, 'server.key'), pems.private);
  fs.writeFileSync(path.join(certsDir, 'server.crt'), pems.cert);

  console.log('✅ Certificati generati in ./certs/');
  console.log(`   Validi per: localhost, 127.0.0.1, ${LOCAL_IP}`);
  console.log(`   Scadenza: 825 giorni`);
  console.log('');
  console.log('📱 Per fidarsi del certificato su iPhone:');
  console.log(`   1. Apri Safari → https://${LOCAL_IP}:3000/health → "Visita il sito"`);
  console.log('   2. Impostazioni → Generali → Info → Impostazioni certificato → attiva fiducia');
  console.log(`   3. Poi apri https://${LOCAL_IP}:5173`);
  console.log('');
  console.log('🤖 Per Android:');
  console.log(`   1. Apri Chrome → https://${LOCAL_IP}:3000/health → "Avanzate" → "Procedi"`);
  console.log(`   2. Poi apri https://${LOCAL_IP}:5173`);
}

main().catch(err => { console.error('❌ Errore:', err.message); process.exit(1); });
