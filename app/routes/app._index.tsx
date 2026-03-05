import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";

type LoaderData = {
  message: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
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
    // ✅ IMPORTANT: Shopify throws redirect Responses (302) that MUST be re-thrown
    if (error instanceof Response) {
      throw error;
    }

    console.error("Error creating carrier service", error);
    message =
      "Could not talk to Shopify to create the carrier service. Check Render logs.";
  }

  return { message } satisfies LoaderData;
};

export default function IndexPage() {
  const data = useLoaderData() as LoaderData;

  return (
    <div style={{ padding: 16 }}>
      <h1>Shipwise Shopify App</h1>
      <p>{data.message}</p>
      <p>
        Go to <strong>Settings → Shipping and delivery</strong> to turn on the
        Shipwise rates.
      </p>
    </div>
  );
}
