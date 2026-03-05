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
    const data: ActionData = { ok: false, message: "Paste a token, then save." };
    return data;
  }

  await prisma.shipwiseConfig.upsert({
    where: { shop },
    update: { bearerToken: token },
    create: { shop, bearerToken: token },
  });

  const data: ActionData = { ok: true, message: "Saved." };
  return data;
};

export default function ShipwiseSettingsPage() {
  const { shop, hasToken } = useLoaderData() as LoaderData;
  const actionData = useActionData() as ActionData | undefined;

  return (
    <div style={{ padding: 16, maxWidth: 720 }}>
      <h1>Shipwise Settings</h1>

      <p>
        Store: <code>{shop}</code>
      </p>

      <p>
        Token saved: <strong>{hasToken ? "Yes" : "No"}</strong>
      </p>

      {actionData ? (
        <p style={{ marginTop: 8 }}>
          <strong>
            {actionData.ok ? "✅" : "⚠️"} {actionData.message}
          </strong>
        </p>
      ) : null}

      <div style={{ marginTop: 16 }}>
        <Form method="post">
          <label style={{ display: "block", marginBottom: 8 }}>
            Shipwise Bearer Token
          </label>

          <input
            name="bearerToken"
            type="password"
            autoComplete="off"
            placeholder="Paste token here"
            style={{ width: "100%", padding: 10, fontSize: 14 }}
          />

          <button
            type="submit"
            style={{ marginTop: 12, padding: "10px 14px", fontSize: 14 }}
          >
            Save token
          </button>
        </Form>
      </div>
    </div>
  );
}
