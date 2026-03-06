import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";

// ---------------------------------------------------------------------------
// Tiny local json() helper (since react-router doesn't export one here)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Environment configuration
// ---------------------------------------------------------------------------

const SHIPWISE_API_URL =
  process.env.SHIPWISE_API_URL ?? "https://api.shipwise.com";

// Optional fallback store domain if the request header is missing.
// Example: "your-store.myshopify.com"
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;

// Required if you want the app to fetch the exact variant weight + unit
// from Shopify Admin and stop relying on callback grams.
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Set to true if Shipwise returns rates in CENTS instead of dollars
const SHIPWISE_RETURNS_CENTS = false;

// Metafield namespace and keys for product dimensions
// You must set up these metafields in Shopify Admin > Settings > Custom data > Products
const DIMENSION_METAFIELD_NAMESPACE = "shipping"; // or "custom" - match your store setup
const DIMENSION_KEYS = {
  length: "length", // metafield key for length (in inches)
  width: "width", // metafield key for width (in inches)
  height: "height", // metafield key for height (in inches)
};

// Default dimensions if metafields are not set (fallback)
const DEFAULT_DIMENSIONS = {
  length: 10,
  width: 8,
  height: 4,
};

// Simple helper to generate a correlation ID for logging
function createCorrelationId() {
  return `shipwise-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Helper: Exact grams -> pounds fallback conversion
// ---------------------------------------------------------------------------
function gramsToPoundsExact(grams: number) {
  if (!Number.isFinite(grams) || grams <= 0) return 0;

  // Exact conversion. Keep precision, do not round up.
  return Number((grams / 453.59237).toFixed(6));
}

// ---------------------------------------------------------------------------
// Helper: Convert Shopify's stored variant weight/unit into pounds
// ---------------------------------------------------------------------------
function shopifyWeightToPounds(
  weight: number | null | undefined,
  weightUnit: string | null | undefined
): number | null {
  if (weight == null || !Number.isFinite(weight) || weight <= 0) return null;

  switch (weightUnit) {
    case "POUNDS":
      return Number(weight.toFixed(6));
    case "OUNCES":
      return Number((weight / 16).toFixed(6));
    case "KILOGRAMS":
      return Number((weight * 2.20462262185).toFixed(6));
    case "GRAMS":
      return Number((weight / 453.59237).toFixed(6));
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  address3?: string | null;
  phone?: string | null;
  email?: string | null;
  company?: string | null;
  company_name?: string | null;
};

type ShopifyCartItem = {
  name?: string;
  sku?: string;
  quantity?: number;
  grams?: number;
  price?: number; // cents
  requires_shipping?: boolean;
  product_id?: number;
  variant_id?: number;
  properties?: Record<string, string> | null;
  vendor?: string;
  fulfillment_service?: string;
};

type ShopifyRateRequest = {
  rate?: {
    origin?: ShopifyAddress;
    destination?: ShopifyAddress;
    items?: ShopifyCartItem[];
    currency?: string;
    locale?: string;
  };
};

type VariantShippingData = {
  length: number;
  width: number;
  height: number;
  weightLb: number | null;
};

type ShipwiseRate = {
  carrierService?: string | null;
  carrierCode?: string | null;
  carrier?: string | null;
  class?: string | null;
  value?: number | null;
  currencyCodeIso?: string | null;
  transitTime?: {
    estimatedDeliveryDays?: number | null;
    estimatedDeliveryDate?: string | null;
  } | null;
  estimatedDeliveryDays?: number | null;
  estimatedDeliveryDate?: string | null;
};

type ShipwiseShipmentItem = {
  packageId?: string | null;
  selectedRate?: ShipwiseRate | null;
  rates?: ShipwiseRate[] | null;
};

type ShipwiseResponse = {
  // Legacy / original fields
  wasSuccessful?: boolean;
  responseMsg?: string | null;
  shipmentItems?: ShipwiseShipmentItem[] | null;
  externalServices?: ShipwiseRate[] | null;
  rateErrors?: string[] | null;

  // Newer / simplified shape used by Shipwise Akila endpoint
  success?: boolean;
  customer?: string | null;
  profileId?: string | null;
  rates?: ShipwiseRate[] | null | any[];
};

type NormalizedShipwiseRate = {
  serviceName: string;
  serviceCode: string;
  value: number;
  currency: string | null;
  estimatedDeliveryDate?: string | null;
  estimatedDeliveryDays?: number | null;
};

// ---------------------------------------------------------------------------
// Helper: Fetch variant dimensions + exact variant weight from Shopify Admin
// ---------------------------------------------------------------------------
async function fetchVariantShippingData(
  variantIds: number[],
  correlationId: string,
  requestedShopDomain: string | null
): Promise<Map<number, VariantShippingData>> {
  const shippingDataMap = new Map<number, VariantShippingData>();

  const adminStoreDomain = requestedShopDomain || SHOPIFY_STORE_DOMAIN;

  // If we cannot call Shopify Admin, we will fall back to callback grams later.
  if (!adminStoreDomain || !SHOPIFY_ADMIN_ACCESS_TOKEN) {
    console.warn(
      "[Shipwise] Missing Shopify Admin API credentials - exact variant weight lookup disabled; falling back to callback grams",
      {
        correlationId,
        adminStoreDomain,
        hasAdminToken: !!SHOPIFY_ADMIN_ACCESS_TOKEN,
      }
    );
    return shippingDataMap;
  }

  const uniqueVariantIds = [...new Set(variantIds)];
  if (!uniqueVariantIds.length) {
    return shippingDataMap;
  }

  const variantGids = uniqueVariantIds.map(
    (id) => `gid://shopify/ProductVariant/${id}`
  );

  const query = `
    query GetVariantShippingData($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          legacyResourceId
          weight
          weightUnit
          metafield_length: metafield(namespace: "${DIMENSION_METAFIELD_NAMESPACE}", key: "${DIMENSION_KEYS.length}") {
            value
          }
          metafield_width: metafield(namespace: "${DIMENSION_METAFIELD_NAMESPACE}", key: "${DIMENSION_KEYS.width}") {
            value
          }
          metafield_height: metafield(namespace: "${DIMENSION_METAFIELD_NAMESPACE}", key: "${DIMENSION_KEYS.height}") {
            value
          }
        }
      }
    }
  `;

  try {
    const response = await fetch(
      `https://${adminStoreDomain}/admin/api/2024-10/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN,
        },
        body: JSON.stringify({
          query,
          variables: { ids: variantGids },
        }),
      }
    );

    if (!response.ok) {
      console.error("[Shipwise] Failed to fetch variant shipping data", {
        status: response.status,
        correlationId,
        adminStoreDomain,
      });
      return shippingDataMap;
    }

    const data = await response.json();

    if (data.errors) {
      console.error("[Shipwise] GraphQL errors fetching variant shipping data", {
        errors: data.errors,
        correlationId,
        adminStoreDomain,
      });
      return shippingDataMap;
    }

    for (const node of data.data?.nodes ?? []) {
      if (!node || !node.legacyResourceId) continue;

      const variantId = parseInt(node.legacyResourceId, 10);

      const length =
        parseFloat(node.metafield_length?.value) || DEFAULT_DIMENSIONS.length;
      const width =
        parseFloat(node.metafield_width?.value) || DEFAULT_DIMENSIONS.width;
      const height =
        parseFloat(node.metafield_height?.value) || DEFAULT_DIMENSIONS.height;

      const weightLb = shopifyWeightToPounds(node.weight, node.weightUnit);

      shippingDataMap.set(variantId, {
        length,
        width,
        height,
        weightLb,
      });
    }

    console.log("[Shipwise] Fetched variant shipping data", {
      correlationId,
      adminStoreDomain,
      variantCount: shippingDataMap.size,
      variants: Object.fromEntries(shippingDataMap),
    });
  } catch (err) {
    console.error("[Shipwise] Error fetching variant shipping data", {
      err,
      correlationId,
      adminStoreDomain,
    });
  }

  return shippingDataMap;
}

// ---------------------------------------------------------------------------
// Helper: Convert Shopify address to Shipwise format
// ---------------------------------------------------------------------------
function convertAddress(addr: ShopifyAddress | undefined, fallbackName: string) {
  if (!addr) {
    return {
      name: fallbackName,
      company: "",
      address1: "",
      address2: "",
      address3: "",
      city: "",
      state: "",
      postalCode: "",
      countryCode: "",
      phone: "",
      email: "",
    };
  }

  return {
    name: addr.name ?? fallbackName,
    company: addr.company ?? addr.company_name ?? "",
    address1: addr.address1 ?? "",
    address2: addr.address2 ?? "",
    address3: addr.address3 ?? "",
    city: addr.city ?? "",
    state: addr.province ?? addr.province_code ?? "",
    postalCode: addr.postal_code ?? addr.zip ?? "",
    countryCode: addr.country_code ?? addr.country ?? "",
    phone: addr.phone ?? "",
    email: addr.email ?? "",
  };
}

// ---------------------------------------------------------------------------
// Main action – called by Shopify during checkout
// ---------------------------------------------------------------------------
export const action = async ({ request }: ActionFunctionArgs) => {
  console.log(">>> Shipwise rates endpoint CALLED");
  const correlationId = createCorrelationId();

  if (request.method !== "POST") {
    console.error("[Shipwise] Non-POST request hit /api/shipwise/rates", {
      method: request.method,
      correlationId,
    });
    return json({ error: "Method Not Allowed", correlationId }, { status: 405 });
  }

  // Shopify usually sends this header on the carrier callback
  const shopDomain =
    request.headers.get("x-shopify-shop-domain") ||
    request.headers.get("X-Shopify-Shop-Domain") ||
    null;

  // Fetch Shipwise token from DB for that shop
  const config = shopDomain
    ? await prisma.shipwiseConfig.findUnique({ where: { shop: shopDomain } })
    : null;

  // Optional fallback to env var while setting up
  const shipwiseBearerToken =
    config?.bearerToken || process.env.SHIPWISE_BEARER_TOKEN;

  // If no token, do not break checkout — return no rates
  if (!shipwiseBearerToken) {
    console.error("[Shipwise] No token saved for this store", {
      correlationId,
      shopDomain,
    });
    return json({ rates: [] }, { status: 200 });
  }

  // -------------------------------------------------------------------------
  // Parse Shopify request
  // -------------------------------------------------------------------------

  let shopifyBody: ShopifyRateRequest;
  try {
    shopifyBody = (await request.json()) as ShopifyRateRequest;
  } catch (err) {
    console.error("[Shipwise] Failed to parse Shopify JSON payload", {
      err,
      correlationId,
    });
    return json({ rates: [] }, { status: 400 });
  }

  const rate = shopifyBody.rate;
  if (!rate) {
    console.error("[Shipwise] Missing rate object in Shopify payload", {
      bodyKeys: Object.keys(shopifyBody || {}),
      correlationId,
    });
    return json({ rates: [] }, { status: 400 });
  }

  console.log("[Shipwise] Received Shopify rate request", {
    correlationId,
    shopDomain,
    hasOrigin: !!rate.origin,
    originCountry: rate.origin?.country_code || rate.origin?.country,
    originPostal: rate.origin?.postal_code || rate.origin?.zip,
    hasDestination: !!rate.destination,
    destCountry: rate.destination?.country_code || rate.destination?.country,
    destPostal: rate.destination?.postal_code || rate.destination?.zip,
    itemCount: rate.items?.length ?? 0,
    currency: rate.currency,
  });

  const origin = rate.origin;
  const destination = rate.destination;
  const items = rate.items ?? [];

  if (!items.length) {
    console.warn("[Shipwise] No items in Shopify rate request", {
      correlationId,
    });
    return json({ rates: [] }, { status: 200 });
  }

  const shopCurrency = rate.currency ?? "USD";

  // -------------------------------------------------------------------------
  // Fetch exact variant shipping data from Shopify Admin
  // -------------------------------------------------------------------------

  const shippableItems = items.filter((i) => i.requires_shipping !== false);

  const variantIds = shippableItems
    .filter((i) => i.variant_id)
    .map((i) => i.variant_id!);

  const shippingDataMap = await fetchVariantShippingData(
    variantIds,
    correlationId,
    shopDomain
  );

  // -------------------------------------------------------------------------
  // Build Shipwise request body
  // -------------------------------------------------------------------------

  const shipwiseItems = shippableItems.map((item, index) => {
    const quantity = item.quantity ?? 1;
    const grams = item.grams ?? 0;

    const shippingData = item.variant_id
      ? shippingDataMap.get(item.variant_id)
      : undefined;

    const hasVariantWeight =
      typeof shippingData?.weightLb === "number" &&
      Number.isFinite(shippingData.weightLb) &&
      shippingData.weightLb > 0;

    const weightPerItemLb = hasVariantWeight
      ? shippingData!.weightLb!
      : gramsToPoundsExact(grams);

    if (!hasVariantWeight) {
      console.warn(
        "[Shipwise] Using callback grams fallback instead of exact Shopify variant weight",
        {
          correlationId,
          variantId: item.variant_id,
          sku: item.sku ?? item.name ?? `item-${index + 1}`,
          grams,
          fallbackWeightLb: weightPerItemLb,
        }
      );
    }

    const length = shippingData?.length ?? DEFAULT_DIMENSIONS.length;
    const width = shippingData?.width ?? DEFAULT_DIMENSIONS.width;
    const height = shippingData?.height ?? DEFAULT_DIMENSIONS.height;

    return {
      id: index + 1,
      sku: item.sku ?? item.name ?? `item-${index + 1}`,
      description: item.name ?? item.sku ?? "Item",
      quantity,
      // Weight in pounds - exact Shopify variant weight first, grams fallback second
      weight: weightPerItemLb,
      length,
      width,
      height,
      price: (item.price ?? 0) / 100,
      productId: item.product_id,
      variantId: item.variant_id,
    };
  });

  const shipwiseOrigin = convertAddress(origin, "Origin");
  const shipwiseDestination = convertAddress(destination, "Destination");

  const shipwiseRequestBody = {
    items: shipwiseItems,
    origin: shipwiseOrigin,
    destination: shipwiseDestination,
    currency: shopCurrency,
  };

  const shipwiseUrl = `${SHIPWISE_API_URL.replace(/\/$/, "")}/api/shipping-rates`;

  console.log("[Shipwise] Sending request to Shipwise API", {
    correlationId,
    url: shipwiseUrl,
    origin: {
      city: shipwiseOrigin.city,
      state: shipwiseOrigin.state,
      postalCode: shipwiseOrigin.postalCode,
      country: shipwiseOrigin.countryCode,
    },
    destination: {
      city: shipwiseDestination.city,
      state: shipwiseDestination.state,
      postalCode: shipwiseDestination.postalCode,
      country: shipwiseDestination.countryCode,
    },
    itemCount: shipwiseItems.length,
    items: shipwiseItems.map((i, idx) => {
      const originalItem = shippableItems[idx];
      const shippingData = originalItem?.variant_id
        ? shippingDataMap.get(originalItem.variant_id)
        : undefined;

      const hasVariantWeight =
        typeof shippingData?.weightLb === "number" &&
        Number.isFinite(shippingData.weightLb) &&
        shippingData.weightLb > 0;

      return {
        sku: i.sku,
        qty: i.quantity,
        weight: i.weight.toFixed(6),
        weightSource: hasVariantWeight
          ? "variantWeight"
          : "callbackGramsFallback",
        dims: `${i.length}x${i.width}x${i.height}`,
      };
    }),
  });

  // -------------------------------------------------------------------------
  // Call Shipwise API
  // -------------------------------------------------------------------------

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  let shipwiseRes: Response;
  try {
    shipwiseRes = await fetch(shipwiseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${shipwiseBearerToken}`,
        "X-Correlation-ID": correlationId,
      },
      body: JSON.stringify(shipwiseRequestBody),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    console.error("[Shipwise] Network error calling Shipwise API", {
      err,
      correlationId,
    });
    return json({ rates: [] }, { status: 502 });
  }

  clearTimeout(timeoutId);

  let shipwiseJson: ShipwiseResponse;
  try {
    shipwiseJson = (await shipwiseRes.json()) as ShipwiseResponse;
  } catch (err) {
    console.error("[Shipwise] Failed to parse Shipwise JSON response", {
      status: shipwiseRes.status,
      err,
      correlationId,
    });
    return json({ rates: [] }, { status: 502 });
  }

  console.log("[Shipwise] Received response from Shipwise", {
    correlationId,
    status: shipwiseRes.status,
    wasSuccessful: shipwiseJson.wasSuccessful,
    success: shipwiseJson.success,
    responseMsg: shipwiseJson.responseMsg,
    shipmentItems: shipwiseJson.shipmentItems?.length ?? 0,
    externalServices: shipwiseJson.externalServices?.length ?? 0,
    rates:
      (shipwiseJson as any).rates && Array.isArray((shipwiseJson as any).rates)
        ? (shipwiseJson as any).rates.length
        : (shipwiseJson as any).rates
          ? 1
          : 0,
    rateErrors: shipwiseJson.rateErrors,
  });

  console.log("[Shipwise] Full Shipwise response body", {
    correlationId,
    body: shipwiseJson,
  });

  if (
    !shipwiseRes.ok ||
    shipwiseJson.wasSuccessful === false ||
    shipwiseJson.success === false
  ) {
    console.error("[Shipwise] Shipwise API responded with error", {
      status: shipwiseRes.status,
      body: shipwiseJson,
      correlationId,
    });
    return json({ rates: [] }, { status: 502 });
  }

  // -------------------------------------------------------------------------
  // Normalize and collect all rates
  // -------------------------------------------------------------------------

  const allRates: NormalizedShipwiseRate[] = [];

  for (const item of shipwiseJson.shipmentItems ?? []) {
    const candidateRates: ShipwiseRate[] = [];
    if (item.selectedRate) candidateRates.push(item.selectedRate);
    if (Array.isArray(item.rates)) candidateRates.push(...item.rates);

    for (const r of candidateRates) {
      if (!r || r.value == null || r.value <= 0) continue;

      const valueInDollars = SHIPWISE_RETURNS_CENTS ? r.value / 100 : r.value;

      allRates.push({
        serviceName:
          r.carrierService ?? r.class ?? r.carrier ?? r.carrierCode ?? "Shipping",
        serviceCode: r.carrierService ?? r.carrierCode ?? r.class ?? "standard",
        value: valueInDollars,
        currency: r.currencyCodeIso ?? shopCurrency,
        estimatedDeliveryDate:
          r.estimatedDeliveryDate ?? r.transitTime?.estimatedDeliveryDate ?? null,
        estimatedDeliveryDays:
          r.estimatedDeliveryDays ?? r.transitTime?.estimatedDeliveryDays ?? null,
      });
    }
  }

  for (const r of shipwiseJson.externalServices ?? []) {
    if (!r || r.value == null || r.value <= 0) continue;

    const valueInDollars = SHIPWISE_RETURNS_CENTS ? r.value / 100 : r.value;

    allRates.push({
      serviceName:
        r.carrierService ?? r.class ?? r.carrier ?? r.carrierCode ?? "Shipping",
      serviceCode: r.carrierService ?? r.carrierCode ?? r.class ?? "external",
      value: valueInDollars,
      currency: r.currencyCodeIso ?? shopCurrency,
      estimatedDeliveryDate:
        r.estimatedDeliveryDate ?? r.transitTime?.estimatedDeliveryDate ?? null,
      estimatedDeliveryDays:
        r.estimatedDeliveryDays ?? r.transitTime?.estimatedDeliveryDays ?? null,
    });
  }

  const topLevelRates = (shipwiseJson as any).rates;
  if (Array.isArray(topLevelRates)) {
    console.log("[Shipwise] Processing top-level Shipwise rates", {
      correlationId,
      count: topLevelRates.length,
    });

    for (const raw of topLevelRates) {
      if (!raw) continue;

      const rawValue =
        (raw as any).value ??
        (raw as any).total ??
        (raw as any).amount ??
        (raw as any).price ??
        (raw as any).rate ??
        null;

      let numericValue: number | null = null;
      if (typeof rawValue === "number") {
        numericValue = rawValue;
      } else if (typeof rawValue === "string") {
        const parsed = Number(rawValue);
        if (!Number.isNaN(parsed)) {
          numericValue = parsed;
        }
      }

      if (numericValue == null || numericValue <= 0) continue;

      const valueInDollars = SHIPWISE_RETURNS_CENTS
        ? numericValue / 100
        : numericValue;

      const currency =
        (raw as any).currencyCodeIso ??
        (raw as any).currency ??
        (raw as any).currency_code ??
        shopCurrency;

      const serviceName =
        (raw as any).serviceName ??
        (raw as any).service ??
        (raw as any).carrierService ??
        (raw as any).class ??
        (raw as any).carrier ??
        (raw as any).carrierCode ??
        "Shipping";

      const serviceCode =
        (raw as any).serviceCode ??
        (raw as any).carrierService ??
        (raw as any).carrierCode ??
        (raw as any).class ??
        "standard";

      const estimatedDeliveryDays =
        (raw as any).estimatedDeliveryDays ??
        (raw as any).transitDays ??
        (raw as any).transit_time ??
        (raw as any).transitTime?.estimatedDeliveryDays ??
        null;

      const estimatedDeliveryDate =
        (raw as any).estimatedDeliveryDate ??
        (raw as any).transitTime?.estimatedDeliveryDate ??
        null;

      allRates.push({
        serviceName,
        serviceCode,
        value: valueInDollars,
        currency,
        estimatedDeliveryDate,
        estimatedDeliveryDays,
      });
    }
  }

  if (!allRates.length) {
    console.warn("[Shipwise] No usable rates returned from Shipwise", {
      body: shipwiseJson,
      correlationId,
    });
    return json({ rates: [] }, { status: 200 });
  }

  console.log("[Shipwise] All rates from Shipwise", {
    correlationId,
    rates: allRates.map((r) => ({
      service: r.serviceName,
      code: r.serviceCode,
      value: r.value,
      currency: r.currency,
    })),
  });

  // -------------------------------------------------------------------------
  // Find the LOWEST rate
  // -------------------------------------------------------------------------

  const lowestRate = allRates.reduce((min, r) => (r.value < min.value ? r : min));

  const totalPriceCents = Math.round(lowestRate.value * 100);

  const shopifyRate = {
    service_name: lowestRate.serviceName,
    service_code: lowestRate.serviceCode,
    total_price: totalPriceCents.toString(),
    currency: lowestRate.currency ?? shopCurrency,
    ...(lowestRate.estimatedDeliveryDate
      ? {
          min_delivery_date: lowestRate.estimatedDeliveryDate,
          max_delivery_date: lowestRate.estimatedDeliveryDate,
        }
      : {}),
  };

  console.log("[Shipwise] Returning LOWEST rate to Shopify", {
    correlationId,
    selectedRate: {
      service: shopifyRate.service_name,
      code: shopifyRate.service_code,
      priceCents: shopifyRate.total_price,
      currency: shopifyRate.currency,
    },
    allRatesCount: allRates.length,
  });

  return json({ rates: [shopifyRate] }, { status: 200 });
};
