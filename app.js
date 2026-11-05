import express from "express";
import { createServerApp } from "./index.js";

const app = await createServerApp(express());

export default app;
