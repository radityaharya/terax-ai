import { describe, expect, it } from "vitest";
import {
  composeProjectName,
  posixDirname,
  projectInFolder,
} from "./compose";

describe("posixDirname", () => {
  it("strips the basename", () => {
    expect(posixDirname("/home/u/docker-services/postgres/docker-compose.yml")).toBe(
      "/home/u/docker-services/postgres",
    );
  });

  it("handles root and relative paths", () => {
    expect(posixDirname("/x")).toBe("/");
    expect(posixDirname("compose.yml")).toBe("/");
  });
});

describe("composeProjectName", () => {
  it("lowercases and sanitizes the directory basename", () => {
    expect(composeProjectName("/home/u/OmniRoute")).toBe("omniroute");
    expect(composeProjectName("/home/u/my app.v2")).toBe("myappv2");
  });

  it("ignores trailing slashes", () => {
    expect(composeProjectName("/home/u/postgres/")).toBe("postgres");
  });
});

describe("projectInFolder", () => {
  const cwd = "/home/u/docker-services/postgres";

  it("matches on working dir", () => {
    expect(
      projectInFolder(
        { projectDir: "/home/u/docker-services/postgres/", files: [] },
        cwd,
      ),
    ).toBe(true);
  });

  it("falls back to the config file's directory", () => {
    expect(
      projectInFolder(
        {
          projectDir: "",
          files: ["/home/u/docker-services/postgres/docker-compose.yml"],
        },
        cwd,
      ),
    ).toBe(true);
  });

  it("rejects unrelated folders and a null cwd", () => {
    expect(
      projectInFolder(
        {
          projectDir: "/home/u/other",
          files: ["/home/u/other/docker-compose.yml"],
        },
        cwd,
      ),
    ).toBe(false);
    expect(projectInFolder({ projectDir: cwd, files: [] }, null)).toBe(false);
  });
});
