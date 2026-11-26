import { GoogleAuth } from "google-auth-library";
import { cache } from "react";

export const getReadApiIdentityToken = cache(async (audience: string) => {
  const client = await new GoogleAuth().getIdTokenClient(audience);
  const headers = await client.getRequestHeaders(audience);
  return headers.Authorization ?? headers.authorization;
});
