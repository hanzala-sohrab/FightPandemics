/* eslint-disable no-console */

const mongoose = require("mongoose");
const Airtable = require("airtable");
require("dotenv").config();

const {
  config: { mongo, airtable },
} = require("../../config");
require("../../lib/models/User");
const { schema: userSchema } = require("../../lib/models/User");
const { schema: postSchema } = require("../../lib/models/Post");
const mapAirtableData = require("./map-airtable-data");

const POSTS_AIRTABLE_NAME = "Posts";
const SOURCED_BY_FP_USER = {
  name: "Sourced by FightPandemics",
};
const DEFAULT_MAX_RECORDS = 100;

/* TODO: consider library (commander, yargs)
  For now single positional arg to control records fetched:
    a) all records: 'npm run import-posts -- -1';
    b) specify X >= 1: 'npm run import-posts -- X';
    c) default: 'npm run import-posts' */
const parseMaxRecordsArg = () => {
  const maxRecordsArg = process.argv[2];
  return parseInt(maxRecordsArg, 10) || DEFAULT_MAX_RECORDS;
};

const importPostsFromAirtable = async (connection, sourcedById) => {
  const start = Date.now();

  const base = new Airtable({
    apiKey: airtable.apiKey,
  }).base(airtable.baseId);

  const Post = connection.model("Post", postSchema);
  let failedPosts = 0;

  const selectOptions = { maxRecords: parseMaxRecordsArg() };
  const records = await base(POSTS_AIRTABLE_NAME).select(selectOptions).all(); // ~8-9s to get from Airtable ~2500 posts; ~2-3s to bulk write to mongo (locally on docker network)

  const bulkOps = [];
  records.forEach((record) => {
    try {
      const postsData = mapAirtableData(record._rawJson, {
        id: sourcedById,
        name: SOURCED_BY_FP_USER.name,
      });

      // bulk write does not perform validation; only include posts that pass validate
      const validationError = new Post(postsData).validateSync();
      if (validationError) {
        throw new Error(JSON.stringify(validationError.errors));
      }

      bulkOps.push({
        updateOne: {
          filter: { airtableId: record.id },
          update: postsData,
          upsert: true,
        },
      });
    } catch (err) {
      failedPosts += 1;
      console.error(
        `${record.id} failed mapping/validation. Error message: ${
          err.message
        }. Record fields: ${JSON.stringify(record._rawJson.fields)}.`
      );
    }
  });

  try {
    const bulkWriteOpResult = await Post.bulkWrite(bulkOps);
    const { nUpserted, nModified } = bulkWriteOpResult;
    const end = Date.now();
    console.log(
      `Imported ${nUpserted + nModified} from Airtable in ${
        (end - start) / 1000
      }s. Inserted ${nUpserted} new posts; updated ${nModified} existing posts. ${failedPosts} posts failed to import.`
    );
  } catch (err) {
    console.error(`Bulk write failed. Error message: ${err.message}`);
  }
};

const initSourcedByFPUser = async (connection) => {
  const User = connection.model("User", userSchema);
  const filter = { name: SOURCED_BY_FP_USER.name };
  return User.findOneAndUpdate(filter, SOURCED_BY_FP_USER, {
    new: true,
    upsert: true,
    useFindAndModify: false,
  });
};

(async () => {
  const connection = await mongoose.createConnection(mongo.uri, mongo.params);
  try {
    const sourcedBy = await initSourcedByFPUser(connection);
    await importPostsFromAirtable(connection, sourcedBy._id);
    process.exit();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
