import { createApp } from "vue";
import App from "./App.vue";
import { appConfig } from "./app-config";
import { i18n } from "./i18n";
import "./styles.css";

document.title = appConfig.productName;
createApp(App).use(i18n).mount("#app");
