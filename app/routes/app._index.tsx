import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form } from "react-router";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

type LoaderData = {
  carrierExists: boolean;
  hasToken: boolean;
  shop: string;
};

type ActionData = {
  message: string;
  success: boolean;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const listQuery = `#graphql
    query CarrierServiceList {
      carrierServices(first: 10) {
        nodes {
          id
          name
          active
        }
      }
    }
  `;

  let carrierExists = false;

  try {
    const response = await admin.graphql(listQuery);
    const json = await response.json();
    const carriers = json.data?.carrierServices?.nodes ?? [];
    carrierExists = carriers.some(
      (c: { name: string }) =>
        c.name === "33 Degrees Live Rates" || c.name === "Shipwise Live Rates"
    );
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("Error checking carrier services", error);
  }

  const record = await prisma.shipwiseConfig.findUnique({ where: { shop } });
  const hasToken = Boolean(record?.bearerToken);

  return { carrierExists, hasToken, shop } satisfies LoaderData;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const mutation = `#graphql
    mutation CarrierServiceCreate($input: DeliveryCarrierServiceCreateInput!) {
      carrierServiceCreate(input: $input) {
        carrierService {
          id
          name
          callbackUrl
          active
          supportsServiceDiscovery
        }
        userErrors {
          message
        }
      }
    }
  `;

  const appUrl = process.env.SHOPIFY_APP_URL || "";
  const callbackUrl = new URL("/api/shipwise/rates", appUrl).toString();

  const variables = {
    input: {
      name: "33 Degrees Live Rates",
      callbackUrl,
      active: true,
      supportsServiceDiscovery: true,
    },
  };

  try {
    const response = await admin.graphql(mutation, { variables });
    const json = await response.json();
    const userErrors = json.data?.carrierServiceCreate?.userErrors ?? [];

    if (userErrors.length > 0) {
      return { message: "Carrier service is already registered.", success: true } satisfies ActionData;
    }
    return { message: "Carrier service registered successfully.", success: true } satisfies ActionData;
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("Error creating carrier service", error);
    return { message: "Something went wrong. Please check logs and try again.", success: false } satisfies ActionData;
  }
};

export default function IndexPage() {
  const { carrierExists, hasToken } = useLoaderData() as LoaderData;
  const actionData = useActionData() as ActionData | undefined;
  const carrierReady = carrierExists || actionData?.success;

  return (
    <s-page heading="33 Degrees Live Rates">
      <s-section heading="Getting started">
        <s-paragraph>
          Accurate shipping rates powered by 33 Degrees. Follow the steps below to get your store connected.
        </s-paragraph>
      </s-section>

      <s-section heading="Step 1: Register carrier service">
        {carrierReady ? (
          <s-banner tone="success">Carrier service is registered.</s-banner>
        ) : (
          <>
            <s-paragraph>Register 33 Degrees as a shipping rate provider for your store.</s-paragraph>
            {actionData && !actionData.success ? (
              <s-banner tone="critical">{actionData.message}</s-banner>
            ) : null}
            <Form method="post">
              <button type="submit" style={{ padding: "8px 16px", fontSize: 14, cursor: "pointer" }}>
                Register carrier service
              </button>
            </Form>
          </>
        )}
      </s-section>

      <s-section heading="Step 2: Add your API token">
        {hasToken ? (
          <s-banner tone="success">
            API token is saved. <a href="/app/shipwise-settings">Update token</a>
          </s-banner>
        ) : (
          <>
            <s-paragraph>Paste your 33 Degrees API token on the Settings page to connect your account.</s-paragraph>
            <a href="/app/shipwise-settings">
              <button type="button" style={{ padding: "8px 16px", fontSize: 14, cursor: "pointer" }}>Go to Settings</button>
            </a>
          </>
        )}
      </s-section>

      <s-section heading="Step 3: Enable rates in Shopify">
        <s-paragraph>
          Go to Settings, then Shipping and delivery in your Shopify admin. Find 33 Degrees Live Rates under your shipping profile and turn it on.
        </s-paragraph>
      </s-section>

      {carrierReady && hasToken ? (
        <s-section>
          <s-banner tone="success">Everything looks good. Your store is ready to show live shipping rates at checkout.</s-banner>
        </s-section>
      ) : null}

      <s-section slot="aside" heading="Need help?">
        <s-paragraph>
          Contact us at LetsDoThis@33-degrees.com
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
