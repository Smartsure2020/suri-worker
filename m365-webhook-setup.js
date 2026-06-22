// =============================================================
// M365 webhook subscription setup
// Run once (locally or in CI) to register the Suri mailbox
// webhook with Microsoft Graph.
// Renew every ~2 days (M365 max subscription = 3 days for mail).
// =============================================================
//
// Usage:
//   AZURE_TENANT_ID=xxx AZURE_CLIENT_ID=xxx AZURE_CLIENT_SECRET=xxx \
//   M365_WEBHOOK_SECRET=xxx SURI_MAILBOX=claims@smartsure.co.za \
//   WORKER_URL=https://claims.novachrono.app \
//   node m365-webhook-setup.js

async function getToken() {
  const res = await fetch(
    `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     process.env.AZURE_CLIENT_ID,
        client_secret: process.env.AZURE_CLIENT_SECRET,
        scope:         'https://graph.microsoft.com/.default',
      }),
    }
  );
  const data = await res.json();
  return data.access_token;
}

async function createSubscription(token) {
  const expiry = new Date(Date.now() + 2.5 * 24 * 60 * 60 * 1000).toISOString();

  const res = await fetch('https://graph.microsoft.com/v1.0/subscriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      changeType:          'created',
      notificationUrl:     `${process.env.WORKER_URL}/webhooks/email`,
      resource:            `users/${process.env.SURI_MAILBOX}/mailFolders/inbox/messages`,
      expirationDateTime:  expiry,
      clientState:         process.env.M365_WEBHOOK_SECRET,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    console.error('Subscription creation failed:', JSON.stringify(data, null, 2));
    process.exit(1);
  }

  console.log('Subscription created:');
  console.log('  ID:      ', data.id);
  console.log('  Expires: ', data.expirationDateTime);
  console.log('  Resource:', data.resource);
  console.log('\nStore the subscription ID — you need it to renew.');
  console.log('Set up a cron job to renew every 2 days:');
  console.log(`  node m365-webhook-setup.js renew ${data.id}`);
}

async function renewSubscription(token, subscriptionId) {
  const expiry = new Date(Date.now() + 2.5 * 24 * 60 * 60 * 1000).toISOString();

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/subscriptions/${subscriptionId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expirationDateTime: expiry }),
    }
  );

  const data = await res.json();
  if (!res.ok) {
    console.error('Renewal failed:', JSON.stringify(data, null, 2));
    process.exit(1);
  }
  console.log('Subscription renewed. New expiry:', data.expirationDateTime);
}

(async () => {
  const token = await getToken();
  const [,, command, subscriptionId] = process.argv;

  if (command === 'renew' && subscriptionId) {
    await renewSubscription(token, subscriptionId);
  } else {
    await createSubscription(token);
  }
})();
