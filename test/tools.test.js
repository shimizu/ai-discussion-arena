import assert from "node:assert/strict";
import test from "node:test";

import { ToolRegistry } from "../src/tools/registry.js";

function stubFetch(handler) {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => handler(String(url)),
    };
  };
  return {
    urls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

test("e-Stat未設定ならe-Statツールは提示されない", () => {
  const registry = new ToolRegistry({ estatAppId: "" });
  const names = registry.definitions().map((tool) => tool.name);
  assert.ok(!names.some((name) => name.startsWith("estat_")));
  assert.ok(names.includes("worldbank_search_indicators"));
});

test("e-Stat設定済みなら全ツールが提示される", () => {
  const registry = new ToolRegistry({ estatAppId: "app-id" });
  const names = registry.definitions().map((tool) => tool.name);
  assert.equal(names.length, 5);
  assert.ok(names.includes("estat_fetch_data"));
});

test("未知のツール名は使えるツールを添えて拒否される", async () => {
  const registry = new ToolRegistry({ estatAppId: "x" });
  await assert.rejects(
    registry.execute("search_the_web", {}),
    /未登録のツールです.*estat_search_tables/s,
  );
});

test("World Bankの時系列は表として整形される", async () => {
  const stub = stubFetch(() => [
    { page: 1, pages: 1, total: 3 },
    [
      {
        indicator: { id: "NY.GDP.PCAP.CD", value: "GDP per capita (current US$)" },
        country: { value: "Japan" },
        countryiso3code: "JPN",
        date: "2022",
        value: 34017.3,
      },
      {
        indicator: { id: "NY.GDP.PCAP.CD", value: "GDP per capita (current US$)" },
        country: { value: "Japan" },
        countryiso3code: "JPN",
        date: "2021",
        value: 40058.0,
      },
      // 欠損値は落とす。
      {
        indicator: { id: "NY.GDP.PCAP.CD", value: "GDP per capita (current US$)" },
        country: { value: "Japan" },
        countryiso3code: "JPN",
        date: "2023",
        value: null,
      },
    ],
  ]);

  try {
    const registry = new ToolRegistry({});
    const result = await registry.execute("worldbank_fetch_indicator", {
      indicatorId: "NY.GDP.PCAP.CD",
      countries: "JPN",
      dateRange: "2021:2023",
    });

    assert.match(result.content, /GDP per capita/);
    assert.match(result.content, /World Bank World Development Indicators/);
    // 年の降順で並ぶ。
    assert.ok(result.content.indexOf("2022") < result.content.indexOf("2021"));
    // 欠損年は表に出ない。
    assert.ok(!result.content.includes("| 2023 |"));
    // 全2件と数えられている。
    assert.match(result.content, /全2件/);

    // CSV用のデータは生の数値のまま持つ（ロケール整形はcontent側だけ）。
    assert.deepEqual(result.dataset.columns, ["国", "iso3", "年", "値"]);
    assert.equal(result.dataset.totalRows, 2);
    assert.deepEqual(result.dataset.rows[0], {
      国: "Japan",
      iso3: "JPN",
      年: "2022",
      値: 34017.3,
    });
    assert.equal(typeof result.dataset.rows[0].値, "number");

    assert.match(stub.urls[0], /country\/JPN\/indicator\/NY\.GDP\.PCAP\.CD/);
    assert.match(stub.urls[0], /date=2021%3A2023/);
  } finally {
    stub.restore();
  }
});

test("表示は40行までだが、CSV用のデータには全行が残る", async () => {
  const stub = stubFetch(() => [
    { page: 1, pages: 1, total: 50 },
    Array.from({ length: 50 }, (_, index) => ({
      indicator: { id: "NY.GDP.PCAP.CD", value: "GDP per capita (current US$)" },
      country: { value: "Japan" },
      countryiso3code: "JPN",
      date: String(1970 + index),
      value: 1000 + index,
    })),
  ]);

  try {
    const registry = new ToolRegistry({});
    const result = await registry.execute("worldbank_fetch_indicator", {
      indicatorId: "NY.GDP.PCAP.CD",
      countries: "JPN",
    });

    // contentは表示上限で切られ、その旨が書かれている。
    const tableRows = result.content
      .split("\n")
      .filter((line) => /^\| Japan \|/.test(line));
    assert.equal(tableRows.length, 40);
    assert.match(result.content, /全50件のうち直近40件/);

    // datasetは全50件を保持する。
    assert.equal(result.dataset.rows.length, 50);
    assert.equal(result.dataset.totalRows, 50);
    // 年の降順。
    assert.equal(result.dataset.rows[0].年, "2019");
    assert.equal(result.dataset.rows.at(-1).年, "1970");
  } finally {
    stub.restore();
  }
});

test("World Bankがエラーを返したら理由が伝わる", async () => {
  const stub = stubFetch(() => [
    { message: [{ key: "Invalid value", value: "The provided parameter value is not valid" }] },
  ]);

  try {
    const registry = new ToolRegistry({});
    await assert.rejects(
      registry.execute("worldbank_fetch_indicator", {
        indicatorId: "BAD.ID",
        countries: "JPN",
      }),
      /not valid/,
    );
  } finally {
    stub.restore();
  }
});

test("国コード未指定は分かるエラーになる", async () => {
  const registry = new ToolRegistry({});
  await assert.rejects(
    registry.execute("worldbank_fetch_indicator", { indicatorId: "X", countries: "" }),
    /countries/,
  );
});

test("e-Statのフィルタ配列がクエリへ展開され、名称列だけが表になる", async () => {
  const stub = stubFetch(() => ({
    GET_STATS_DATA: {
      RESULT: { STATUS: 0 },
      STATISTICAL_DATA: {
        TABLE_INF: { TITLE_SPEC: { TABLE_NAME: "消費者物価指数" } },
        CLASS_INF: {
          CLASS_OBJ: [
            {
              "@id": "cat01",
              CLASS: [{ "@code": "0001", "@name": "総合", "@unit": "2020=100" }],
            },
            {
              "@id": "time",
              CLASS: [{ "@code": "2023000000", "@name": "2023年" }],
            },
          ],
        },
        DATA_INF: {
          VALUE: [
            { "@cat01": "0001", "@time": "2023000000", "@unit": "2020=100", $: "105.6" },
          ],
        },
        RESULT_INF: {},
      },
    },
  }));

  try {
    const registry = new ToolRegistry({ estatAppId: "test-app-id" });
    const result = await registry.execute("estat_fetch_data", {
      statsDataId: "0003427113",
      filters: [
        { key: "cdCat01", value: "0001" },
        { key: "cdTimeFrom", value: "2023000000" },
      ],
    });

    // フィルタがクエリパラメータへ展開されている。
    assert.match(stub.urls[0], /cdCat01=0001/);
    assert.match(stub.urls[0], /cdTimeFrom=2023000000/);
    assert.match(stub.urls[0], /appId=test-app-id/);

    // 分類名と値の列が出て、生のコード列は出ない。
    assert.match(result.content, /消費者物価指数/);
    assert.match(result.content, /cat01_name/);
    assert.match(result.content, /総合/);
    assert.match(result.content, /105\.6/);
    assert.ok(!result.content.includes("| cat01 |"));

    // CSV側は原データを辿れるよう、表示しない生のコード列も残す。
    assert.deepEqual(result.dataset.columns, [
      "cat01_name",
      "time_name",
      "value",
      "unit",
      "cat01",
      "time",
    ]);
    assert.equal(result.dataset.rows[0].value, 105.6);
    assert.equal(result.dataset.rows[0].cat01, "0001");
  } finally {
    stub.restore();
  }
});

test("e-StatのAPIエラーはそのまま伝わる", async () => {
  const stub = stubFetch(() => ({
    GET_STATS_LIST: {
      RESULT: { STATUS: 100, ERROR_MSG: "該当するデータはありません。" },
    },
  }));

  try {
    const registry = new ToolRegistry({ estatAppId: "x" });
    await assert.rejects(
      registry.execute("estat_search_tables", { searchWord: "存在しない統計" }),
      /該当するデータはありません/,
    );
  } finally {
    stub.restore();
  }
});

test("appId未設定でe-Statツールを呼ぶと理由が返る", async () => {
  const registry = new ToolRegistry({ estatAppId: "" });
  await assert.rejects(
    registry.execute("estat_search_tables", { searchWord: "人口" }),
    /アプリケーションIDが未設定/,
  );
});

test("ツールの表示名は引数を含む", () => {
  const registry = new ToolRegistry({ estatAppId: "x" });
  assert.equal(
    registry.describeTool("estat_search_tables", { searchWord: "人口動態" }),
    "e-Stat統計表検索「人口動態」",
  );
  assert.equal(registry.sourceOf("worldbank_fetch_indicator"), "World Bank");
});
