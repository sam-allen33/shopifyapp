import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";

// This is the text we send from the server down to the page
type LoaderData = {
  message: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // This line logs in to the store as your app
  const { admin } = await authenticate.admin(request);

  // This is a "special request" that asks Shopify to create a carrier
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

    const userErrors =
      json.data?.carrierServiceCreate?.userErrors ?? [];

    if (userErrors.length > 0) {
      console.log("CarrierServiceCreate userErrors", userErrors);
      message =
        "Shipwise carrier is already set up or had minor issues. You can still continue to Shipping settings.";
    } else {
      message =
        "Shipwise carrier is set up. Next step: turn it on in your store's Shipping settings.";
    }
  } catch (error) {
    console.error("Error creating carrier service", error);
    message =
      "There was an error talking to Shopify. Check the dev server window for details.";
  }

  const data: LoaderData = { message };
  return data;
};

export default function IndexPage() {
  const data = useLoaderData() as LoaderData;

  return (
    <div style={{ padding: 16 }}>
      <h1>Shipwise Shopify App</h1>
      <p>{data.message}</p>
      <p>
        After this step, you'll go to your store's{" "}
        <strong>Settings → Shipping and delivery</strong> page
        to turn on the new Shipwise rates.
      </p>
    </div>
  );
}
