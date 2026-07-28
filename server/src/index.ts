import "dotenv/config";
import express, { type Request, type Response } from "express";

const app = express();

app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  console.log(`Clipwise server listening on port ${port}`);
});
