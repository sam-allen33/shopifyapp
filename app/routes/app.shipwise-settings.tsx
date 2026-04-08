import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

type LoaderData = {
  shop: string;
  hasToken: boolean;
};

type ActionData = {
  ok: boolean;
  message: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const record = await prisma.shipwiseConfig.findUnique({ where: { shop } });

  const data: LoaderData = {
    shop,
    hasToken: Boolean(record?.bearerToken),
  };

  return data;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const token = String(formData.get("bearerToken") || "").trim();

  if (!token) {
    const data: ActionData = { ok: false, message: "Please paste your API token, then save." };
    return data;
  }

  await prisma.shipwiseConfig.upsert({
    where: { shop },
    update: { bearerToken: token },
    create: { shop, bearerToken: token },
  });

  const data: ActionData = { ok: true, message: "API token saved successfully." };
  return data;
};

export default function SettingsPage() {
  const { shop, hasToken } = useLoaderData() as LoaderData;
  const actionData = useActionData() as ActionData | undefined;

  return (
    <s-page heading="Settings">
      <s-section heading="Store">
        <s-paragraph>
          Connected store: <strong>{shop}</strong>
        </s-paragraph>
      </s-section>

      <s-section heading="33 Degrees API Token">
        <s-paragraph>
          {hasToken
            ? "Your API token is saved. Paste a new token below to replace it."
            : "Paste the API token from your 33 Degrees account to connect your store."}
        </s-paragraph>

        {actionData ? (
          <s-banner tone={actionData.ok ? "success" : "critical"}>
            {actionData.message}
          </s-banner>
        ) : null}

        <Form method="post">
          <s-text-field
            label="33 Degrees API Token"
            name="bearerToken"
            type="password"
            autocomplete="off"
          ></s-text-field>

          <div style={{ marginTop: 12 }}>
            <s-button variant="primary" submit>
              Save token
            </s-button>
          </div>
        </Form>
      </s-section>

      <s-section slot="aside" heading="Where do I find my token?">
        <s-paragraph>
          Your API token is provided by 33 Degrees. If you don't have one,
          contact us at{" "}
          <s-link href="mailto:LetsDoThis@33-degrees.com" target="_blank">
            LetsDoThis@33-degrees.com
          </s-link>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
