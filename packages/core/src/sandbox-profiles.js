// Built-in sandbox profiles: ready-made wrapper templates so users can contain
// the agent with one setting instead of hand-writing a full `docker run` line.
// {image} is substituted here; {shadow}/{repo} are substituted at launch by the
// agent runner. Network is left enabled because most agents need to reach a
// model API; mount only the shadow workspace, not the real repo or home.
export const SANDBOX_PROFILES = {
  docker: ["docker", "run", "--rm", "-i", "-v", "{shadow}:/work", "-w", "/work", "{image}"],
  podman: ["podman", "run", "--rm", "-i", "-v", "{shadow}:/work", "-w", "/work", "{image}"],
};

export function expandSandboxProfile(name, image) {
  const profile = SANDBOX_PROFILES[name];
  if (!profile) {
    throw new Error(
      `Unknown sandbox profile: ${name}. Available: ${Object.keys(SANDBOX_PROFILES).join(", ")}`,
    );
  }

  const resolvedImage = String(image ?? "").trim();
  if (!resolvedImage) {
    throw new Error(
      `Sandbox profile "${name}" requires an image. Set run.image in .vibeguard/config.json or pass --image.`,
    );
  }

  return profile.map((token) => token.replaceAll("{image}", resolvedImage));
}
