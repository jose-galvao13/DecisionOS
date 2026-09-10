// Deterministic demo dataset used when there's no connected data source.

/* ---------------------------------------------------------------
   DEMO DATASET — deterministic synthetic transactions so the
   product works before any real file is uploaded
----------------------------------------------------------------*/
function seededRandom(seed) {
  let s = seed;
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
}
function generateDemoTransactions() {
  const rnd = seededRandom(42);
  const products = ["Produto A", "Produto B", "Produto X", "Produto D", "Produto E"];
  const regions = ["Portugal", "Espanha", "França", "Alemanha", "Itália"];
  const channels = ["Direto", "E-commerce", "Revendedor", "Parceiros"];
  const txs = [];
  const start = new Date(2025, 6, 1);
  let custPool = Array.from({ length: 180 }, (_, i) => `CUST-${1000 + i}`);
  let txnId = 0;
  for (let m = 0; m < 14; m++) {
    const monthDate = new Date(start.getFullYear(), start.getMonth() + m, 1);
    const activeCustomers = m < 8 ? custPool : custPool.slice(0, 150 - (m - 8) * 6); // simulate churn late
    // A handful of "growing" and "new" customers only start buying from month 9 on,
    // and discounting creeps up over time — both feed customer/profit intelligence.
    const newCustomers = m >= 9 ? Array.from({ length: 4 }, (_, i) => `CUST-${9000 + m * 10 + i}`) : [];
    const pool = [...activeCustomers, ...newCustomers];
    const rowsThisMonth = 55 + Math.floor(rnd() * 20);
    for (let i = 0; i < rowsThisMonth; i++) {
      const product = products[Math.floor(rnd() * products.length)];
      const region = regions[Math.floor(rnd() * regions.length)];
      const channel = channels[Math.floor(rnd() * channels.length)];
      const customer = pool[Math.floor(rnd() * pool.length)];
      const day = 1 + Math.floor(rnd() * 27);
      const qty = 1 + Math.floor(rnd() * 12);
      const basePrice = { "Produto A": 92, "Produto B": 61, "Produto X": 140, "Produto D": 45, "Produto E": 77 }[product];
      const unitPrice = basePrice * (0.9 + rnd() * 0.2);
      const grossRevenue = qty * unitPrice;
      // Discount pressure increases gradually in the second half of the period —
      // a real, data-derived driver for the profit bridge (not a hardcoded label).
      const discountRate = 0.02 + (m / 14) * 0.06 + rnd() * 0.02;
      const discount = Math.round(grossRevenue * discountRate);
      const revenue = Math.round(grossRevenue - discount);
      // Produto X: cost ratio creeps up over time -> margin decline (a real signal, not a hardcoded label)
      let costRatio = product === "Produto X" ? 0.58 + (m / 14) * 0.22 : 0.55 + rnd() * 0.12;
      const cost = Math.round(revenue * costRatio);
      txs.push({
        id: `TXN-${txnId++}`,
        date: new Date(monthDate.getFullYear(), monthDate.getMonth(), day),
        product, region, channel, customer,
        productId: slugify(product), customerId: slugify(customer), regionId: slugify(region), channelId: slugify(channel),
        quantity: qty, unitPrice, discount,
        revenue, cost, profit: revenue - cost,
        currency: "EUR", source: "demo",
      });
    }
  }
  return txs.sort((a, b) => a.date - b.date);
}


export { seededRandom, generateDemoTransactions };
