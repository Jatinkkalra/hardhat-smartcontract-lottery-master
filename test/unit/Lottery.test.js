const { getNamedAccounts, deployments, network, ethers } = require("hardhat");
const {
  developmentChains,
  networkConfig,
} = require("../../helper-hardhat-config");
const { assert, expect } = require("chai");

!developmentChains.includes(network.name)
  ? describe.skip
  : describe("Lottery Unit Test", function () {
      let deployer, lottery, vrfCoordinatorV2Mock, lotteryEntranceFee, interval;
      const chainId = network.config.chainId;

      beforeEach(async function () {
        deployer = (await getNamedAccounts()).deployer;
        await deployments.fixture(["all"]);
        lottery = await ethers.getContract("Lottery", deployer);
        vrfCoordinatorV2Mock = await ethers.getContract(
          "VRFCoordinatorV2Mock",
          deployer
        );
        lotteryEntranceFee = await lottery.getEntranceFee();
        interval = await lottery.getInterval();
      });
      // first test: constructor
      describe("constructor", function () {
        it("initializes the Lottery correctly", async function () {
          // Ideally we make our tests have just 1 assert per "it"
          const lotteryState = await lottery.getLotteryState();
          assert.equal(lotteryState.toString(), "0");
          assert.equal(interval.toString(), networkConfig[chainId]["interval"]);
        });
      });

      // Test: Enter Lottery
      describe("enterLottery", function () {
        it("reverts when you don't pay enough", async function () {
          await expect(lottery.enterLottery()).to.be.revertedWith(
            "Lottery__NotEnoughETHEntered"
          );
        });
        it("records players when they enter", async function () {
          await lottery.enterLottery({ value: lotteryEntranceFee });
          const playerFromContract = await lottery.getPlayers(0);
          assert.equal(playerFromContract, deployer);
        });

        it("doesn't allow entrane when lottery is in CALCULATING state", async function () {
          await lottery.enterLottery({ value: lotteryEntranceFee });
          // Creating scenario for checkUpKeep to be true, so that performUpKeep can be true where lottery is in CALCULATING state
          await network.provider.send("evm_increaseTime", [
            interval.toNumber() + 1,
          ]);
          await network.provider.send("evm_mine", []); // mining one block
          // Other way: network.provider.request({ method: "evm_mine", params: [] });

          // Calling performUpkeep now by pretending to be a Chainlink Keeper. Lottery in CALCULATING state afterwards.
          await lottery.performUpkeep([
            /* empty bytes data */
          ]);
          await expect(
            lottery.enterLottery({ value: lotteryEntranceFee })
          ).to.be.revertedWith("Lottery__NotOpen");
        });

        it("emits event on entry", async function () {
          await expect(
            lottery.enterLottery({ value: lotteryEntranceFee })
          ).to.emit(lottery, "LotteryEnter");
        });
      });

      // Test: checkUpkeep function
      describe("checkUpkeep", function () {
        it("returns false if people haven't sent any ETH", async function () {
          await network.provider.send("evm_increaseTime", [
            interval.toNumber() + 1,
          ]);
          await network.provider.send("evm_mine", []);
          const { upKeepNeeded } = await lottery.callStatic.checkUpkeep([]); // using `callStatic` to stimulate the checkUpkeep function
          assert(!upKeepNeeded);
        });

        it("returns false if lottery isn't in open state", async function () {
          await lottery.enterLottery({ value: lotteryEntranceFee });
          await network.provider.send("evm_increaseTime", [
            interval.toNumber() + 1,
          ]);
          await network.provider.send("evm_mine", []);
          await lottery.performUpkeep([
            /* empty bytes data */
          ]);
          const lotteryState = await lottery.getLotteryState();
          const { upkeepNeeded } = await lottery.callStatic.checkUpkeep([]); // using `callStatic` to stimulate the checkUpkeep function
          assert.equal(lotteryState.toString(), "1");
          assert.equal(upkeepNeeded, false);
        });

        it("returns false if enough time hasn't passed", async () => {
          await lottery.enterLottery({ value: lotteryEntranceFee });
          await network.provider.send("evm_increaseTime", [
            interval.toNumber() - 5,
          ]); // use a higher number here if this test fails
          await network.provider.request({ method: "evm_mine", params: [] });
          const { upkeepNeeded } = await lottery.callStatic.checkUpkeep("0x"); // upkeepNeeded = (timePassed && isOpen && hasBalance && hasPlayers)
          assert(!upkeepNeeded);
        });

        it("returns true if enough time has passed, has players, eth, and is open", async () => {
          await lottery.enterLottery({ value: lotteryEntranceFee });
          await network.provider.send("evm_increaseTime", [
            interval.toNumber() + 1,
          ]);
          await network.provider.request({ method: "evm_mine", params: [] });
          const { upkeepNeeded } = await lottery.callStatic.checkUpkeep("0x"); // upkeepNeeded = (timePassed && isOpen && hasBalance && hasPlayers)
          assert(upkeepNeeded);
        });
      });
      describe("performUpkeep", function () {
        it("will only run if checkUpkeep function is true", async function () {
          await lottery.enterLottery({ value: lotteryEntranceFee });
          await network.provider.send("evm_increaseTime", [
            interval.toNumber() + 1,
          ]);
          await network.provider.request({ method: "evm_mine", params: [] });
          const tx = await lottery.performUpkeep([]);
          assert(tx);
        });

        it("will revert error when checkUpkeep is false", async function () {
          await expect(lottery.performUpkeep([])).to.be.revertedWith(
            "Lottery_checkUpKeepfalse"
          );
        });
        it("updates the lottery state to CALCULATING, emits `RequestedLotteryWinner(requestId)` & calls VRFCoordinatorV2Mock for random words", async function () {
          await lottery.enterLottery({ value: lotteryEntranceFee });
          await network.provider.send("evm_increaseTime", [
            interval.toNumber() + 1,
          ]);
          await network.provider.request({ method: "evm_mine", params: [] });
          const txResponse = await lottery.performUpkeep([]);
          const txReceipt = await txResponse.wait(1);
          const requestId = txReceipt.events[1].args.requestId;
          const lotteryState = await lottery.getLotteryState();

          assert(requestId.toNumber() > 0);
          assert(lotteryState.toString() == 1);
        });
      });

      // Tests fullfillRandomWords function
      describe("fulfillRandomWords", function () {
        beforeEach(async function () {
          await lottery.enterLottery({ value: lotteryEntranceFee });
          await network.provider.send("evm_increaseTime", [
            interval.toNumber() + 1,
          ]);
          await network.provider.request({ method: "evm_mine", params: [] });
        });
        it("can only be called after performUpkeep", async function () {
          await expect(
            vrfCoordinatorV2Mock.fulfillRandomWords(0, lottery.address)
          ).to.be.revertedWith("nonexistent request"); // chainlink's vrf function `.fulfillRandomWords`

          await expect(
            vrfCoordinatorV2Mock.fulfillRandomWords(1, lottery.address)
          ).to.be.revertedWith("nonexistent request");
        });

        // A very big test, thus we will split into various sections:
        it("picks a winner and emits to a winner list, changes Lottery status to OPEN, resets the lottery array & timestamp, and send money or reverts error otherwise", async function () {
          const additionalEntrants = 3;
          const startingAccountIndex = 1; // as deployer = 0
          const accounts = await ethers.getSigners(); // used to fetch multiple acccounts from metamask

          for (
            let i = startingAccountIndex;
            i < startingAccountIndex + additionalEntrants;
            i++
          ) {
            const accountConnectedToLottery = lottery.connect(accounts[i]); // connecting to each account 1 by 1
            await accountConnectedToLottery.enterLottery({
              value: lotteryEntranceFee,
            });
            const startingTimeStamp = await lottery.getLatestTimeStamp();

            // performUpkeep (mock being Chainlink Keepers); kicks of fulfillRandomWords (mock being Chainlink VRF)
            // to not wait for fulfillRandomWords to be called:
            await new Promise(async (resolve, reject) => {
              lottery.once("WinnerPicked", async () => {
                // listen for `WinnerPicked` event and then execute the function
                console.log("Found the event!");
                try {
                  const recentWinner = await lottery.getRecentWinner();
                  const lotteryState = await lottery.getLotteryState();
                  const endingTimeStamp = await lottery.getLatestTimeStamp();
                  const numPlayers = await lottery.getNumberOfPlayers();
                  const winnerEndingBalance = await accounts[1].getBalance();

                  console.log(recentWinner);
                  console.log(accounts[0].address);
                  console.log(accounts[1].address);
                  console.log(accounts[2].address);
                  console.log(accounts[3].address);

                  assert.equal(numPlayers.toString(), "0");
                  assert.equal(lotteryState.toString(), "0");
                  assert(endingTimeStamp > startingTimeStamp);
                  assert.equal(
                    winnerEndingBalance.toString(),
                    winnerStartingBalance.add(
                      raffleEntranceFee
                        .mul(additionalEntrants)
                        .add(raffleEntranceFee)
                        .toString()
                    )
                  );
                  resolve();
                } catch (e) {
                  reject(e);
                }
              });
              // Setting up the listener

              // Below, we will fire the event, and the listener will pick it up, and resolve
              const tx = await lottery.performUpkeep([]);
              const txReceipt = await tx.wait(1);
              const winnerStartingBalance = await accounts[1].getBalance();
              await vrfCoordinatorV2Mock.fulfillRandomWords(
                txReceipt.events[1].args.requestId,
                lottery.address
              ); // chainlink's vrf function `.fulfillRandomWords`
            });
          }
        });
      });
    });
