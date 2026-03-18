import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";

function json(data: unknown, init?: number | ResponseInit): Response {
  const body = JSON.stringify(data);

  if (typeof init === "number") {
    return new Response(body, {
      status: init,
      headers: { "Content-Type": "application/json" },
    });
  }

  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return new Response(body, {
    ...init,
    headers,
  });
}

const SHIPWISE_API_URL = process.env.SHIPWISE_API_URL ?? "https://api.shipwise.com";
const SHIPWISE_DEBUG_VERBOSE =
  (process.env.SHIPWISE_DEBUG_VERBOSE ?? "false").toLowerCase() === "true";

type ShopifyAddress = {
  country?: string;
  country_code?: string;
  postal_code?: string;
  zip?: string;
  province?: string;
  province_code?: string;
  city?: string;
  name?: string | null;
  address1?: string;
  address2?: string;
  phone?: string | null;
  email?: string | null;
};

type ShopifyCartItem = {
  name?: string;
  sku?: string;
  quantity?: number;
  grams?: number;
  price?: number;
  requires_shipping?: boolean;
};

type ShopifyRateRequest = {
  rate?: {
    origin?: ShopifyAddress;
    destination?: ShopifyAddress;
    items?: ShopifyCartItem[];
    currency?: string;
  };
};

function createCorrelationId() {
  return `shipwise-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function logInfo(message: string, details: Record<string, unknown>) {
  console.log(message, details);
}

function logDebug(message: string, details: Record<string, unknown>) {
  if (SHIPWISE_DEBUG_VERBOSE) console.log(message, details);
}

function gramsToPoundsExact(grams: number) {
  if (!Number.isFinite(grams) || grams <= 0) return 0;
  return Number((grams / 453.59237).toFixed(6));
}

function convertAddress(addr: ShopifyAddress | undefined, fallbackName: string) {
  return {
    name: addr?.name ?? fallbackName,
    address1: addr?.address1 ?? "",
    address2: addr?.address2 ?? "",
    city: addr?.city ?? "",
    state: addr?.province ?? addr?.province_code ?? "",
    postalCode: addr?.postal_code ?? addr?.zip ?? "",
    countryCode: addr?.country_code ?? addr?.country ?? "",
    phone: addr?.phone ?? "",
    email: addr?.email ?? "",
  };
}

type AnyRate = {
  carrierService?: string;
  carrierCode?: string;
  class?: string;
  carrier?: string;
  value?: number | string;
  currencyCodeIso?: string;
  estimatedDeliveryDate?: string;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const correlationId = createCorrelationId();
  const startedAt = Date.now();

  if (request.method !== "POST") {
    return json({ error: "Method Not Allowed", correlationId }, { status: 405 });
  }

  const shopDomain =
    request.headers.get("x-shopify-shop-domain") ||
    request.headers.get("X-Shopify-Shop-Domain") ||
    null;

  const config = shopDomain
    ? await prisma.shipwiseConfig.findUnique({ where: { shop: shopDomain } })
    : null;

  const shipwiseBearerToken = config?.bearerToken || process.env.SHIPWISE_BEARER_TOKEN;
  if (!shipwiseBearerToken) {
    logInfo("[Shipwise] Missing token for shop", { correlationId, shopDomain });
    return json({ rates: [] }, { status: 200 });
  }

  let body: ShopifyRateRequest;
  try {
    body = (await request.json()) as ShopifyRateRequest;
  } catch {
    return json({ rates: [] }, { status: 400 });
  }

  const rate = body.rate;
  if (!rate) return json({ rates: [] }, { status: 400 });

  const items = (rate.items ?? []).filter((i) => i.requires_shipping !== false);

  logInfo("[Shipwise] Received rate request", {
    correlationId,
    shopDomain,
    itemCount: items.length,
    currency: rate.currency ?? "USD",
  });

  if (!items.length) return json({ rates: [] }, { status: 200 });

  const shipwiseRequestBody = {
    origin: convertAddress(rate.origin, "Origin"),
    destination: convertAddress(rate.destination, "Destination"),
    currency: rate.currency ?? "USD",
    items: items.map((item, idx) => ({
      id: idx + 1,
      sku: item.sku ?? item.name ?? `item-${idx + 1}`,
      description: item.name ?? item.sku ?? "Item",
      quantity: item.quantity ?? 1,
      weight: gramsToPoundsExact(item.grams ?? 0),
      price: (item.price ?? 0) / 100,
      length: 10,
      width: 8,
      height: 4,
    })),
  };

  logDebug("[Shipwise] Prepared request summary", {
    correlationId,
    shopDomain,
    itemCount: shipwiseRequestBody.items.length,
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  let shipwiseRes: Response;
  try {
    shipwiseRes = await fetch(`${SHIPWISE_API_URL.replace(/\/$/, "")}/api/shipping-rates`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${shipwiseBearerToken}`,
        "X-Correlation-ID": correlationId,
      },
      body: JSON.stringify(shipwiseRequestBody),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timeoutId);
    return json({ rates: [] }, { status: 502 });
  }
  clearTimeout(timeoutId);

  let shipwiseJson: any = {};
  try {
    shipwiseJson = await shipwiseRes.json();
  } catch {
    return json({ rates: [] }, { status: 502 });
  }

  const collected: Array<{ name: string; code: string; value: number; currency: string }> = [];

  const pushRate = (r: AnyRate) => {
    if (!r) return;
    const raw = typeof r.value === "string" ? Number(r.value) : r.value;
    if (!raw || Number.isNaN(raw) || raw <= 0) return;
    collected.push({
      name: r.carrierService ?? r.class ?? r.carrier ?? "Shipping",
      code: r.carrierCode ?? r.carrierService ?? r.class ?? "standard",
      value: raw,
      currency: r.currencyCodeIso ?? (rate.currency ?? "USD"),
    });
  };

  for (const item of shipwiseJson?.shipmentItems ?? []) {
    if (item?.selectedRate) pushRate(item.selectedRate as AnyRate);
    if (Array.isArray(item?.rates)) for (const r of item.rates) pushRate(r as AnyRate);
  }
  for (const r of shipwiseJson?.externalServices ?? []) pushRate(r as AnyRate);
  if (Array.isArray(shipwiseJson?.rates)) for (const r of shipwiseJson.rates) pushRate(r as AnyRate);

  if (!collected.length) {
    logInfo("[Shipwise] No usable rates returned", {
      correlationId,
      shopDomain,
      status: shipwiseRes.status,
      latencyMs: Date.now() - startedAt,
      ratesCount: 0,
    });
    return json({ rates: [] }, { status: 200 });
  }

  const lowest = collected.reduce((a, b) => (b.value < a.value ? b : a));
  const totalPriceCents = Math.round(lowest.value * 100);

  logInfo("[Shipwise] Returning rate to Shopify", {
    correlationId,
    shopDomain,
    status: 200,
    latencyMs: Date.now() - startedAt,
    itemCount: items.length,
    ratesCount: collected.length,
  });

  return json(
    {
      rates: [
        {
          service_name: lowest.name,
          service_code: lowest.code,
          total_price: totalPriceCents.toString(),
          currency: lowest.currency,
        },
      ],
    },
    { status: 200 },
  );
};
