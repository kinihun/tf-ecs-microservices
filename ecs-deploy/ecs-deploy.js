const {execSync} = require('child_process');
const https = require('https');
const { URL } = require('url');
const util = require('util');

function red(string) {
  return `\x1b[31m${string}\x1b[0m`;
}

function exec(args) {
  return execSync(args, { stdio: [void 0, void 0, process.stderr], env: process.env }).toString();
}

function aws(cmd) {
  const response = JSON.parse(exec(`aws ${cmd}`));
  if (response.failures && response.failures.length) {
    throw new Error('The following failures occured: \n' + JSON.stringify(response.failures, null, 2));
  }
  return response;
}

function printUsage() {
  console.log('Usage:');
  console.log('\tnode deploy-ecs.js --region region --cluster cluster --service service --image image [--slack-channel channel --slack-token token]');
  console.log('\tnode deploy-ecs.js --region region --cluster cluster --service service --image image [--container-definition-patch \'{"cpu":64}\']');
  console.log('\tnode deploy-ecs.js --region region --cluster cluster --service service --image image [--container-definition-patch \'{"cpu":64}\'] [--timeout 60]');
}

// take process arguments and convert them into an object
const argv = (() => {
  const argv = {};
  let lastArg = null;
  process.argv.forEach((arg, index, array) => {
    if (arg.indexOf('--') === 0) {
      if (lastArg) {
        argv[lastArg] = true;
        lastArg = null;
      }
      lastArg = arg.substr(2);
      if (array.length === index + 1) {
        // if it's the last one
        argv[arg.substr(2)] = true;
      }
      return;
    }
    if (lastArg) {
      argv[lastArg] = arg;
      lastArg = null;
    }
  });
  return argv;
})();

const required = ['region', 'cluster', 'service', 'image'];
if (required.some(key => !argv[key])) {
  printUsage();
  process.exit(1);
}

const {region, cluster, service, image} = argv;

// validate container-definition
let containerDefinitionPatch;
if (argv['container-definition-patch']) {
  try {
    containerDefinitionPatch = JSON.parse(argv['container-definition-patch']);
    if (('' + containerDefinitionPatch) !== '[object Object]') throw new Error('Invalid container-definition patch');
  } catch (error) {
    console.warn('Error parsing container definition');
    console.error(error);
    console.log('');
    printUsage();
    process.exit(1);
  }
}

function getService() {
  return aws(`ecs describe-services --region "${region}" --cluster "${cluster}" --services "${service}" --output json`).services[0];
}

function getTaskDefinition(arn) {
  return aws(`ecs describe-task-definition --region "${region}" --task-definition "${arn}" --output json`).taskDefinition;
}

function updateTaskDefinition(family, containerDefinitions, taskRoleArn, executionRoleArn, networkMode, volumes, placementConstraints, requiresCompatibilities, cpu, memory) {
  let params = [
    `--region "${region}"`,
    `--family "${family}"`,
    `--container-definitions '${JSON.stringify(containerDefinitions)}'`,
    `--requires-compatibilities "${requiresCompatibilities}"`,
    `--cpu "${cpu}"`,
    `--memory "${memory}"`,
  ];
  if (taskRoleArn) {
    params.push(`--task-role-arn ${taskRoleArn}`);
  } else {
    params.push(`--task-role-arn ""`);
  }
  if (executionRoleArn) {
    params.push(`--execution-role-arn ${executionRoleArn}`);
  } else {
    params.push(`--execution-role-arn ""`);
  }
  if (networkMode) {
    params.push(`--network-mode ${networkMode}`);
  }
  if (volumes) {
    params.push(`--volumes '${JSON.stringify(volumes)}'`);
  }
  if (placementConstraints) {
    params.push(`--placement-constraints '${JSON.stringify(placementConstraints)}'`);
  }
  return aws(`ecs register-task-definition ${params.join(' ')} --output json`).taskDefinition;
}

function updateService(taskDefinitionArn) {
  return aws(`ecs update-service --region "${region}" --cluster "${cluster}" --service "${service}" --task-definition "${taskDefinitionArn}" --output json`).service
}

const SLEEP = 2;
const maxTries = (parseInt(argv.timeout, 10) || 60) / SLEEP

Promise.resolve()
  .then(() => {
    const oldTaskDefinitionArn = getService().taskDefinition;
    console.log(`Old task definion ARN: ${oldTaskDefinitionArn}`);

    const {family, containerDefinitions, taskRoleArn, executionRoleArn, networkMode, volumes, placementConstraints, requiresCompatibilities, cpu, memory} = getTaskDefinition(oldTaskDefinitionArn);
    if (containerDefinitions.length !== 1) {
      throw new Error('Task definitions with more than one container are not supported');
    }

    const newTaskDefinition = updateTaskDefinition(family, [
      {...containerDefinitions[0], ...containerDefinitionPatch, image} // apply patch
    ], taskRoleArn, executionRoleArn, networkMode, volumes, placementConstraints, requiresCompatibilities, cpu, memory);
    console.log(`New task definion ARN: ${newTaskDefinition.taskDefinitionArn}`);

    const newService = updateService(newTaskDefinition.taskDefinitionArn);

    console.log(`Waiting for service ${service} to be deployed`);

    // Wait to see if more than 1 deployment stays running
    for (let i = 0; i <= maxTries; ++ i) {
      const {deployments} = getService();
      if (deployments.length <= 1) {
        process.stdout.write('\n');
        console.log(`New version of ${service} deployed successfully`);
        return;
      }
      process.stdout.write(i % 10 === 9 ? '|' : '.');
      exec(`sleep ${SLEEP}`);
    }
    process.stdout.write('\n');

    // Timeout, rollback
    console.log(red(`Timeout after ${maxTries * SLEEP} seconds`));

    console.log(`Rolling back to ${oldTaskDefinitionArn}`);
    if (argv['slack-channel'] && argv['slack-token']) {
      const POST_OPTIONS = {
        hostname: 'hooks.slack.com',
        path: token,
        method: 'POST',
      };
      const body = {
        channel: channel,
        text: `<!${channel}>\nFailed to deploy \`${service}\` service using new Task Definition`,
      };
      const r = https
        .request(POST_OPTIONS, (res) => {
          res.setEncoding('utf8');
          res.on('data', (data) => {
            console.log(`Message Sent: ${data}`);
          });
        })
      r.on('error', (e) => {
          console.error(e);
      });
      r.write(util.format('%j', body));
      r.end();
    }
    updateService(oldTaskDefinitionArn);

    throw new Error(`Failed to deploy service ${service}`);
  })
  .then(() => process.exit(0))
  .catch(error => {
    process.stdout.write('\x1b[31m'); // red
    console.error(error.stack);
    process.stdout.write('\x1b[0m'); // reset
    process.exit(1);
  });
