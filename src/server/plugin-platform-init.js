export default function(Plugin) {
  // server-side does nothing special, just there for consistency
  return class PluginPlatformInit extends Plugin {};
}
