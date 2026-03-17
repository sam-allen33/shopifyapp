import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  console.log("[Privacy webhook] customers/data_request received", {
    topic,
    shop,
    customerId: payload?.customer?.id ?? null,
    note: "No customer-keyed records are stored by this app.",
  });

  return new Response(null, { status: 200 });
};
