/**
 * Seed a demo org `acme` with alice (admin) + bob + carol (onboarded through the
 * real invite → Mailpit → accept flow), plus one sample message and one task so
 * the app opens with state. Idempotent: re-running logs in instead of erroring.
 *
 *   npm run seed   (run after `make up` / the stack is healthy)
 */
import { BASE, PASSWORD, createOrgOrLogin, inviteAndAccept, login, api } from "./_tb";

async function main() {
  console.log("Seeding demo data into", BASE.auth);

  const alice = await createOrgOrLogin("Acme", "acme", "alice@acme.com", "Alice Admin");
  console.log("✓ org acme + alice (admin)");

  const bob = await inviteAndAccept(alice, "bob@acme.com", "bob", "Bob Builder");
  console.log("✓ bob onboarded via invite");

  const carol = await inviteAndAccept(alice, "carol@acme.com", "carol", "Carol Singer");
  console.log("✓ carol onboarded via invite");

  // Sample message alice → bob
  try {
    await api(BASE.msg, "/api/v1/conversations/messages", {
      token: alice.accessToken,
      body: { recipientId: bob.user.id, body: "Welcome to Task-Board, Bob! 👋", clientMsgId: crypto.randomUUID() },
    });
    console.log("✓ sample message alice → bob");
  } catch (e) {
    console.log("· skipped sample message:", String(e));
  }

  // Sample task alice → carol
  try {
    await api(BASE.task, "/api/v1/tasks", {
      token: alice.accessToken,
      idem: crypto.randomUUID(),
      body: {
        title: "Review the Q3 roadmap",
        description: "Take a look and acknowledge when you start.",
        assigneeIds: [carol.user.id],
      },
    });
    console.log("✓ sample task alice → carol");
  } catch (e) {
    console.log("· skipped sample task:", String(e));
  }

  console.log("\nDemo accounts (sign in with email + password %s):", PASSWORD);
  console.log("  alice@acme.com (admin)\n  bob@acme.com\n  carol@acme.com");
  console.log("Mailpit (invite emails): %s", BASE.mailpit);
}

main().catch((e) => {
  console.error("seed failed:", e);
  process.exit(1);
});
