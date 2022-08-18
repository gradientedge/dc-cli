import { Arguments, Argv } from 'yargs';
import { ConfigurationParameters } from '../configure';
import dynamicContentClientFactory from '../../services/dynamic-content-client-factory';
import { ArchiveLog } from '../../common/archive/archive-log';
import paginator from '../../common/dc-management-sdk-js/paginator';
import UnarchiveOptions from '../../common/archive/unarchive-options';
import { ContentItem, DynamicContent, Status } from 'dc-management-sdk-js';
import { equalsOrRegex } from '../../common/filter/filter';
import { getDefaultLogPath } from '../../common/log-helpers';
import { asyncQuestion } from '../../common/question-helpers';
import { PublishQueue } from '../../common/import/publish-queue';

export const command = 'remove-archived-active-flag [id]';

export const desc = 'Remove Archived Content Item Active Flag';

export const LOG_FILENAME = (platform: string = process.platform): string =>
  getDefaultLogPath('content-item', 'remove-archived-delivery-key', platform);

export const builder = (yargs: Argv): void => {
  yargs
    .positional('id', {
      type: 'string',
      describe:
        'The ID of a content item in the archive to remove the active flag from. If id is not provided, this command will remove active flags from ALL content items in the archive through all content repositories in the hub.'
    })
    .option('repoId', {
      type: 'string',
      describe: 'The ID of a content repository to search items in to remove the active flags.',
      requiresArg: false
    })
    .option('folderId', {
      type: 'string',
      describe: 'The ID of a folder to search items in the archive.',
      requiresArg: false
    })
    .option('name', {
      type: 'string',
      describe:
        'The name of a Content Item in the archive.\nA regex can be provided to select multiple items with similar or matching names (eg /.header/).\nA single --name option may be given to match a single content item pattern.\nMultiple --name options may be given to match multiple content items patterns at the same time, or even multiple regex.'
    })
    .option('contentType', {
      type: 'string',
      describe:
        'A pattern which will only check content items with a matching Content Type Schema ID. A single --contentType option may be given to match a single schema id pattern.\\nMultiple --contentType options may be given to match multiple schema patterns at the same time.'
    })
    .alias('f', 'force')
    .option('f', {
      type: 'boolean',
      boolean: true,
      describe:
        'If present, there will be no confirmation prompt before removing the active flags from the found archived content.'
    })
    .alias('s', 'silent')
    .option('s', {
      type: 'boolean',
      boolean: true,
      describe: 'If present, no log file will be produced.'
    })
    .option('ignoreError', {
      type: 'boolean',
      boolean: true,
      describe: 'If present, unarchive requests that fail will not abort the process.'
    })
    .option('logFile', {
      type: 'string',
      default: LOG_FILENAME,
      describe: 'Path to a log file to write to.'
    });
};

export const filterContentItems = async ({
  name,
  contentType,
  contentItems
}: {
  revertLog?: string;
  name?: string | string[];
  contentType?: string | string[];
  contentItems: ContentItem[];
}): Promise<{ contentItems: ContentItem[]; missingContent: boolean } | undefined> => {
  try {
    const missingContent = false;

    // Filter to content items which have been published before with an active flag
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contentItemsWithActive = contentItems.filter(item => item.body.active && (item as any).lastPublishedVersion);

    if (name != null) {
      const itemsArray: string[] = Array.isArray(name) ? name : [name];
      const contentItemsFiltered = contentItemsWithActive.filter(
        item => itemsArray.findIndex(id => equalsOrRegex(item.label || '', id)) != -1
      );

      return {
        contentItems: contentItemsFiltered,
        missingContent
      };
    }

    if (contentType != null) {
      const itemsArray: string[] = Array.isArray(contentType) ? contentType : [contentType];
      const contentItemsFiltered = contentItemsWithActive.filter(item => {
        return itemsArray.findIndex(id => equalsOrRegex(item.body._meta.schema, id)) != -1;
      });

      return {
        contentItems: contentItemsFiltered,
        missingContent
      };
    }

    return {
      contentItems: contentItemsWithActive,
      missingContent
    };
  } catch (err) {
    console.log(err);
    return {
      contentItems: [],
      missingContent: false
    };
  }
};

export const getContentItems = async ({
  client,
  id,
  hubId,
  repoId,
  folderId,
  revertLog,
  name,
  contentType
}: {
  client: DynamicContent;
  id?: string;
  hubId: string;
  repoId?: string | string[];
  folderId?: string | string[];
  revertLog?: string;
  name?: string | string[];
  contentType?: string | string[];
}): Promise<{ contentItems: ContentItem[]; missingContent: boolean }> => {
  try {
    const contentItems: ContentItem[] = [];

    if (id != null) {
      contentItems.push(await client.contentItems.get(id));

      return {
        contentItems,
        missingContent: false
      };
    }

    const hub = await client.hubs.get(hubId);
    const repoIds = typeof repoId === 'string' ? [repoId] : repoId || [];
    const folderIds = typeof folderId === 'string' ? [folderId] : folderId || [];
    const contentRepositories = await (repoId != null
      ? Promise.all(repoIds.map(id => client.contentRepositories.get(id)))
      : paginator(hub.related.contentRepositories.list));

    const folders = folderId != null ? await Promise.all(folderIds.map(id => client.folders.get(id))) : [];

    folderId != null
      ? await Promise.all(
          folders.map(async source => {
            const items = await paginator(source.related.contentItems.list, { status: Status.ARCHIVED });
            contentItems.push(...items);
          })
        )
      : await Promise.all(
          contentRepositories.map(async source => {
            const items = await paginator(source.related.contentItems.list, { status: Status.ARCHIVED });
            contentItems.push(...items);
          })
        );

    return (
      (await filterContentItems({
        revertLog,
        name,
        contentType,
        contentItems
      })) || {
        contentItems: [],
        missingContent: false
      }
    );
  } catch (err) {
    console.log(err);

    return {
      contentItems: [],
      missingContent: false
    };
  }
};

export const processItems = async ({
  contentItems,
  force,
  silent,
  logFile,
  allContent,
  ignoreError,
  argv
}: {
  contentItems: ContentItem[];
  force?: boolean;
  silent?: boolean;
  logFile?: string;
  allContent: boolean;
  missingContent: boolean;
  ignoreError?: boolean;
  argv: Arguments<UnarchiveOptions & ConfigurationParameters>;
}): Promise<void> => {
  if (contentItems.length == 0) {
    console.log('No active flags found in archived items.');
    return;
  }

  console.log('The following content items in the archive will have the active flags removed:');
  contentItems.forEach((contentItem: ContentItem) => {
    console.log(` ${contentItem.label} (${contentItem.id})`);
  });
  console.log(`Total: ${contentItems.length}`);

  if (!force) {
    const question = allContent
      ? `Providing no ID or filter will remove active flags from all archived content-items! Are you sure you want to do this? (y/n)\n`
      : `Are you sure you want to remove active flags from these archived content-items? (y/n)\n`;

    const yes = await asyncQuestion(question);
    if (!yes) {
      return;
    }
  }

  const timestamp = Date.now().toString();
  const log = new ArchiveLog(`Content Items Remove Archived Active Flag Log - ${timestamp}\n`);

  let successCount = 0;

  const pubQueue = new PublishQueue(argv);
  // log.appendLine(`Publishing ${publishable.length} items. (${publishChildren} children included)`);

  // for (let i = 0; i < publishable.length; i++) {
  //   const item = publishable[i].item;

  //
  // }

  //   log.appendLine(`Waiting for all publishes to complete...`);
  //   await pubQueue.waitForAll();

  //   log.appendLine(`Finished publishing, with ${pubQueue.failedJobs.length} failed publishes total.`);
  //   pubQueue.failedJobs.forEach(job => {
  //     log.appendLine(` - ${job.item.label}`);
  //   });
  // }

  for (let i = 0; i < contentItems.length; i++) {
    try {
      // contentItems[i] = await contentItems[i].related.unarchive();
      // contentItems[i].body.active = false;
      // contentItems[i] = await contentItems[i].related.update(contentItems[i]);
      try {
        await pubQueue.publish(contentItems[i]);
        log.addComment(`Started publish for ${contentItems[i].label}.`);
      } catch (e) {
        log.addComment(`Failed to initiate publish for ${contentItems[i].label}: ${e.toString()}`);
      }
      // await contentItems[i].related.archive();

      log.addAction('REMOVED-ARCHIVED-ACTIVE-FLAG', `${contentItems[i].id}\n`);
      successCount++;
    } catch (e) {
      log.addComment(`REMOVED-ARCHIVED-ACTIVE-FLAG FAILED: ${contentItems[i].id}`);
      log.addComment(e.toString());

      if (ignoreError) {
        log.warn(
          `Failed to remove active flag and re-archive ${contentItems[i].label} (${contentItems[i].id}), current status is ${contentItems[i].status}, continuing.`,
          e
        );
      } else {
        log.error(
          `Failed to remove active flag and re-archive ${contentItems[i].label} (${contentItems[i].id}), current status is ${contentItems[i].status}, aborting.`,
          e
        );
        break;
      }
    }
  }

  if (!silent && logFile) {
    await log.writeToFile(logFile.replace('<DATE>', timestamp));
  }

  console.log(`Remove archived active flag from ${successCount} content items.`);
};

export const handler = async (argv: Arguments<UnarchiveOptions & ConfigurationParameters>): Promise<void> => {
  const { id, logFile, force, silent, ignoreError, hubId, revertLog, repoId, folderId, name, contentType } = argv;
  console.log(argv, process.env);
  const client = dynamicContentClientFactory(argv);

  const allContent = !id && !name && !contentType && !revertLog && !folderId && !repoId;

  if (repoId && id) {
    console.log('ID of content item is specified, ignoring repository ID');
  }

  if (id && name) {
    console.log('Please specify either a item name or an ID - not both.');
    return;
  }

  if (repoId && folderId) {
    console.log('Folder is specified, ignoring repository ID');
  }

  if (allContent) {
    console.log('No filter was given, removing active flags on all archived content');
  }

  const { contentItems, missingContent } = await getContentItems({
    client,
    id,
    hubId,
    repoId,
    folderId,
    revertLog,
    contentType,
    name
  });

  await processItems({
    contentItems,
    force,
    silent,
    logFile,
    allContent,
    missingContent,
    ignoreError,
    argv
  });
};

// log format:
// UNARCHIVE <content item id>
