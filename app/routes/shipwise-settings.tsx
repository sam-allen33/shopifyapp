import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const record = await prisma.shipwiseConfig.findUnique({ where: { shop } });

  return {
    shop,
    hasToken: Boolean(record?.bearerToken),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const token = String(formData.get("bearerToken") || "").trim();

  if (!token) {
    return { ok: false, message: "Please paste a token." };
  }

  await prisma.shipwiseConfig.upsert({
    where: { shop },
    update: { bearerToken: token },
    create: { shop, bearerToken: token },
  });

  return { ok: true, message: "Saved." };
};

export default function ShipwiseSettingsPage() {
  const data = useLoaderData() as { shop: string; hasToken: boolean };

  return (
    <s-page heading="Shipwise Settings">
      <s-section heading="Bearer token">
        <s-paragraph>
          Store: <code>{data.shop}</code>
        </s-paragraph>
        <s-paragraph>
          Token saved: <strong>{data.hasToken ? "Yes" : "No"}</strong>
        </s-paragraph>

        <Form method="post">
          <s-text-field
            label="Shipwise Bearer Token"
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
    </s-page>
  );
}
