import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form } from "react-router";

import { authenticate } from "../shopify.server";

type LoaderData = {
  carrierExists: boolean;
};

type ActionData = {
  message: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  // Check if carrier service already exists instead of creating every time
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
      (c: { name: string }) => c.name === "Shipwise Live Rates"
    );
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("Error checking carrier services", error);
  }

  return { carrierExists } satisfies LoaderData;
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
      name: "Shipwise Live Rates",
      callbackUrl,
      active: true,
      supportsServiceDiscovery: true,
    },
  };

  let message = "Setting up Shipwise Live Rates…";

  try {
    const response = await admin.graphql(mutation, { variables });
    const json = await response.json();

    const userErrors = json.data?.carrierServiceCreate?.userErrors ?? [];

    if (userErrors.length > 0) {
      console.log("CarrierServiceCreate userErrors", userErrors);
      message =
        "Shipwise carrier is already set up. Next step: turn it on in Shipping settings.";
    } else {
      message =
        "Shipwise carrier is set up. Next step: turn it on in Shipping settings.";
    }
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("Error creating carrier service", error);
    message =
      "Could not talk to Shopify to create the carrier service. Check Render logs.";
  }

  return { message } satisfies ActionData;
};

export default function IndexPage() {
  const { carrierExists } = useLoaderData() as LoaderData;
  const actionData = useActionData() as ActionData | undefined;

  return (
    <div style={{ padding: 16 }}>
      <h1>Shipwise Shopify App</h1>

      {actionData ? (
        <p>{actionData.message}</p>
      ) : carrierExists ? (
        <p>
          Shipwise carrier is already set up. Go to{" "}
          <strong>Settings → Shipping and delivery</strong> to manage rates.
        </p>
      ) : (
        <>
          <p>Click the button below to register Shipwise as a shipping rate provider.</p>
          <Form method="post">
            <button type="submit" style={{ padding: "10px 14px", fontSize: 14 }}>
              Set up Shipwise carrier
            </button>
          </Form>
        </>
      )}

      <p>
        Go to <strong>Settings → Shipping and delivery</strong> to turn on the
        Shipwise rates.
      </p>
    </div>
  );
}
