export async function createDepositLink(lead_phone) {
  const squareRes = await fetch(
    "https://connect.squareup.com/v2/online-checkout/payment-links",
    // "https://connect.squareupsandbox.com/v2/online-checkout/payment-links",
    {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
        "Square-Version": "2024-01-18",
      },
      body: JSON.stringify({
        idempotency_key: `deposit-${lead_phone}-${Date.now()}`,
        order: {
          location_id: process.env.SQUARE_LOCATION_ID,
          line_items: [
            {
              name:     "Appointment Deposit — Pure Vision Tints",
              quantity: "1",
              base_price_money: {
                amount:   2000, // $20.00 in cents
                currency: "USD",
              },
            },
          ],
        },
      }),
    }
  );

  const squareData = await squareRes.json();
  console.log("[Deposit Tool] Square response:", JSON.stringify(squareData, null, 2));

  if (!squareRes.ok) {
    throw new Error(squareData.errors?.[0]?.detail || "Square API error");
  }

  const depositUrl = squareData.payment_link.url;
  const orderId = squareData.payment_link.order_id || null;

  console.log(`[Deposit Tool] Square link created: ${depositUrl}, orderId: ${orderId}`);

  return { depositUrl, orderId };
}
