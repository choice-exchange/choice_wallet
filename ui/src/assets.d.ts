// Assets are bundled with the page (esbuild's file loader): importing one gives its URL.
// Nothing is loaded from the network.
declare module "*.css";
declare module "*.png" {
  const url: string;
  export default url;
}
declare module "*.svg" {
  const url: string;
  export default url;
}
