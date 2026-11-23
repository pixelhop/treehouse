// Route middleware that gates pages behind authentication.
// Usage in a page: definePageMeta({ middleware: "auth" })
//
// Every file you open is a navigation (/w/<id>/<path>), so this runs on every
// click in the tree. Awaiting a fresh session request each time put a full API
// round trip in front of every file open. Instead, once the session is known to
// be signed in, navigation goes straight through and the session is re-checked
// in the background (at most once a minute), redirecting to sign-in if it has
// ended. This gate is only UX — the API refuses every request without a valid
// session regardless — so trusting a just-confirmed session for a minute
// exposes nothing the server would hand over. The decision is utils/sessionGate.
import { sessionGate, storeHasUser } from "~/utils/sessionGate";

let lastChecked = 0;

type AuthClient = ReturnType<typeof useAuthClient>;
type SignInRoute = { path: string; query: { redirect: string } };

async function verifyNow(authClient: AuthClient, signIn: SignInRoute) {
  const { data } = await authClient.getSession();
  if (!data) return navigateTo(signIn);
  lastChecked = Date.now();
}

function recheckInBackground(authClient: AuthClient, signIn: SignInRoute) {
  lastChecked = Date.now();
  const router = useRouter();
  authClient
    .getSession()
    .then(({ data }) => (data ? undefined : router.replace(signIn)))
    .catch(() => {
      // Offline or the API is down: not proof of being signed out.
      lastChecked = 0;
    });
}

export default defineNuxtRouteMiddleware((to) => {
  const authClient = useAuthClient();
  const signIn = { path: "/sign-in", query: { redirect: to.fullPath } };
  // Read the session store directly: `useSession()` subscribes for the life of
  // a component, and middleware has none, so each navigation would leak one.
  const gate = sessionGate({
    signedIn: storeHasUser(authClient.$store.atoms.session),
    lastChecked,
    now: Date.now(),
  });
  if (gate === "verify") return verifyNow(authClient, signIn);
  if (gate === "recheck") recheckInBackground(authClient, signIn);
});