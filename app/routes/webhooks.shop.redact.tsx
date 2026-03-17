import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);

  console.log("[Privacy webhook] shop/redact received", { topic, shop });

  await db.$transaction([
    db.session.deleteMany({ where: { shop } }),
    db.shipwiseConfig.deleteMany({ where: { shop } }),
  ]);

  return new Response(null, { status: 200 });
};
