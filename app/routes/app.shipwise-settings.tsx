import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

type LoaderData = {
  shop: string;
  hasToken: boolean;
  hasShipMethod: boolean;
};

type ActionData = {
  ok: boolean;
  message: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const record = await prisma.shipwiseConfig.findUnique({ where: { shop } });
  return {
    shop,
    hasToken: Boolean(record?.bearerToken),
    hasShipMethod: Boolean(process.env.SHIPWISE_SHIP_METHOD),
  } satisfies LoaderData;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const token = String(formData.get("bearerToken") || "").trim();

  if (!token) {
    return { ok: false, message: "Please paste your API token, then save." } satisfies ActionData;
  }

  await prisma.shipwiseConfig.upsert({
    where: { shop },
    update: { bearerToken: token },
    create: { shop, bearerToken: token },
  });

  return { ok: true, message: "API token saved successfully." } satisfies ActionData;
};

export default function SettingsPage() {
  const { shop, hasToken, hasShipMethod } = useLoaderData() as LoaderData;
  const actionData = useActionData() as ActionData | undefined;

  return (
    <s-page heading="Settings">
      {!hasShipMethod && (
        <s-banner tone="warning">
          Shipping rates are disabled: the <strong>SHIPWISE_SHIP_METHOD</strong> environment
          variable is not set on the server. Contact 33 Degrees at LetsDoThis@33-degrees.com
          to obtain the correct value, then add it to your Render environment variables.
        </s-banner>
      )}

      <s-section heading="Store">
        <s-paragraph>Connected store: <strong>{shop}</strong></s-paragraph>
      </s-section>

      <s-section heading="33 Degrees API Token">
        <s-paragraph>
          {hasToken
            ? "Your API token is saved. Paste a new token below to replace it."
            : "Paste the API token from your 33 Degrees account to connect your store."}
        </s-paragraph>

        {actionData ? (
          <s-banner tone={actionData.ok ? "success" : "critical"}>{actionData.message}</s-banner>
        ) : null}

        <Form method="post">
          <div style={{ marginBottom: 8 }}>
            <label htmlFor="bearerToken" style={{ display: "block", marginBottom: 4, fontSize: 14 }}>33 Degrees API Token</label>
            <input
              id="bearerToken"
              name="bearerToken"
              type="password"
              autoComplete="off"
              placeholder="Paste token here"
              style={{ width: "100%", padding: 10, fontSize: 14, boxSizing: "border-box" }}
            />
          </div>
          <button type="submit" style={{ padding: "8px 16px", fontSize: 14, cursor: "pointer" }}>Save token</button>
        </Form>
      </s-section>

      <s-section slot="aside" heading="Where do I find my token?">
        <s-paragraph>
          Your API token is provided by 33 Degrees. If you do not have one, contact us at LetsDoThis@33-degrees.com
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
