import React, { ReactNode } from "react";
import { DataProvider } from "@plasmicapp/loader-nextjs";
import dayjs from "dayjs";
import { Formik, FormikProps } from "formik";
import _ from "lodash";
import qs from "qs";
import * as Yup from "yup";
import { DateIndefinite, DATE_INDEFINITE, FormContext } from "./forms";
import { useMintClaim } from "../hooks/mintClaim";
import DappContext from "./dapp-context";
import { isAddress } from "ethers/lib/utils";
import {
  validateClaimData,
  validateMetaData,
} from "@network-goods/hypercerts-sdk";
import { useAccount } from "wagmi";

/**
 * Constants
 */
const FORM_SELECTOR = "currentForm";
export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 50;

export const DESCRIPTION_MIN_LENGTH = 20;
export const DESCRIPTION_MAX_LENGTH = 500;

export const DEFAULT_NUM_FRACTIONS = "10000";
//const DEFAULT_TIME = dayjs().format("YYYY-MM-DD");
const DEFAULT_TIME = dayjs();
const DEFAULT_FORM_DATA: HypercertCreateFormData = {
  name: "",
  description: "",
  externalLink: "",
  logoUrl: "",
  image: null,
  impactScopes: [] as string[],
  impactTimeStart: DEFAULT_TIME.format("YYYY-MM-DD"),
  impactTimeEnd: DEFAULT_TIME.format("YYYY-MM-DD"),
  workScopes: [] as string[],
  workTimeStart: DEFAULT_TIME.format("YYYY-MM-DD"),
  workTimeEnd: DEFAULT_TIME.format("YYYY-MM-DD"),
  contributors: "",
  allowlistUrl: "",
  rights: [] as string[],

  prev_hypercert: "",
  creators: [],
  uri: "",
  fractions: DEFAULT_NUM_FRACTIONS,
};

interface HypercertCreateFormData {
  name: string;
  description: string;
  externalLink: string;
  image: File | null;
  logoUrl: string;
  impactScopes: string[];
  impactTimeStart?: string;
  impactTimeEnd?: string | DateIndefinite;
  workScopes: string[];
  workTimeStart?: string;
  workTimeEnd?: string;
  contributors: string;
  allowlistUrl: string;
  rights: string[];

  prev_hypercert: string;
  creators: string[];
  uri: string;
  fractions: string;
}

/**
 * Generic utility function to check for valid URLs
 * - We should probably move this to common.ts or util.ts
 * @param value
 * @param opts
 * @returns
 */
const isValidUrl = (
  value: any,
  opts: {
    emptyAllowed?: boolean;
    ipfsAllowed?: boolean;
  }
) => {
  // Check empty, null, or undefined
  if (opts.emptyAllowed && !value) {
    return true;
  } else if (!value) {
    return false;
  }

  // Check IPFS
  const isIpfsUrl = value.match(/^(ipfs):\/\//);
  if (opts.ipfsAllowed && isIpfsUrl) {
    return true;
  }

  try {
    const urlSchema = Yup.string().url();
    urlSchema.validateSync(value);
    return true;
  } catch (e) {
    return false;
  }
};

/**
 * Converts raw form data to a query string
 * @param values
 * @returns
 */
const formDataToQueryString = (values: Record<string, any>) => {
  // We will serialize our Dayjs objects
  const formatDate = (key: string) => {
    if (values[key] === DATE_INDEFINITE) {
      values[key] = DATE_INDEFINITE;
    } else if (values[key] && values[key].format) {
      values[key] = values[key].format("YYYY-MM-DD");
    }
  };
  ["impactTimeStart", "impactTimeEnd", "workTimeStart", "workTimeEnd"].forEach(
    formatDate
  );
  const filteredValues = _.pickBy(values);
  const formattedQueryString = qs.stringify(filteredValues);
  return formattedQueryString;
};

/**
 * Converts a query string into raw form data
 * @param query
 * @returns
 */
const queryStringToFormData = (query?: string) => {
  const rawValues = qs.parse(query ?? "");
  const parseValue = (v: any) => {
    const result = v === DATE_INDEFINITE ? DATE_INDEFINITE : dayjs(v as string);
    //console.log(`${v} => ${result}`);
    return result;
  };
  const values = {
    ...rawValues,
    // we need to parse dates to match the expected types
    impactTimeStart: parseValue(rawValues["impactTimeStart"]),
    impactTimeEnd: parseValue(rawValues["impactTimeEnd"]),
    workTimeStart: parseValue(rawValues["workTimeStart"]),
    workTimeEnd: parseValue(rawValues["workTimeEnd"]),
  };
  return values as any;
};

/**
 * Form validation rules
 */
const ValidationSchema = Yup.object().shape({
  name: Yup.string()
    .min(NAME_MIN_LENGTH, `Name must be at least ${NAME_MIN_LENGTH} characters`)
    .max(NAME_MAX_LENGTH, `Name must be at most ${NAME_MAX_LENGTH} characters`)
    .required("Required"),
  description: Yup.string()
    .min(
      DESCRIPTION_MIN_LENGTH,
      `Description must be at least ${DESCRIPTION_MIN_LENGTH} characters`
    )
    .max(
      DESCRIPTION_MAX_LENGTH,
      `Description must be at most ${DESCRIPTION_MAX_LENGTH} characters`
    )
    .required("Required"),
  externalLink: Yup.string()
    .required("Required")
    .test("valid uri", "Please enter a valid URL", (value) =>
      isValidUrl(value, {
        emptyAllowed: true,
        ipfsAllowed: true,
      })
    ),
  logoUrl: Yup.string().test("valid uri", "Please enter a valid URL", (value) =>
    isValidUrl(value, {
      emptyAllowed: true,
      ipfsAllowed: false,
    })
  ),
  impactScopes: Yup.array().min(1, "Please choose at least 1 item"),
  impactTimeEnd: Yup.date().when(
    ["impactTimeStart", "impactTimeInfinite"],
    (impactTimeStart, impactTimeInfinite) => {
      return Yup.date().min(
        impactTimeInfinite ? 0 : impactTimeStart,
        "End date must be after start date"
      );
    }
  ),
  workScopes: Yup.array().min(1, "Please choose at least 1 item"),
  workTimeEnd: Yup.date().when("workTimeStart", (workTimeStart) => {
    return Yup.date().min(workTimeStart, "End date must be after start date");
  }),
  contributors: Yup.string().required("Required"),
  allowlistUrl: Yup.string().test(
    "valid uri",
    "Please enter a valid URL",
    (value) =>
      isValidUrl(value, {
        emptyAllowed: true,
        ipfsAllowed: true,
      })
  ),
  rights: Yup.array().min(1),
});

/**
 * Hypercert creation form logic using Formik
 * - For the actual layout of form elements,
 *   we assume it's passed in via the `children` prop.
 * - Use the form elements defined in `./forms.tsx`
 * - Make sure that there is a form element with a `fieldName`
 *   for each field in HypercertCreateFormData
 */
export interface HypercertCreateFormProps {
  className?: string; // Plasmic CSS class
  children?: ReactNode; // Form elements
}

export function HypercertCreateForm(props: HypercertCreateFormProps) {
  // TODO: Wrapped in manually, should be a better way to do this?
  return (
    <DappContext>
      <HypercertCreateFormInner {...props} />
    </DappContext>
  );
}

export function HypercertCreateFormInner(props: HypercertCreateFormProps) {
  const { className, children } = props;
  const { address } = useAccount();

  // Query string
  const [initialQuery, setInitialQuery] = React.useState<string | undefined>(
    undefined
  );
  // Load the querystring into React state only once on initial page load
  React.useEffect(() => {
    if (!initialQuery) {
      setInitialQuery(window.location.search.replace("?", ""));
    }
  }, [initialQuery]);

  const { write } = useMintClaim({
    onComplete: () => console.log("Minted hypercert!"),
  });

  return (
    <div className={className}>
      <Formik
        validationSchema={ValidationSchema}
        validateOnMount={true}
        validate={(values) => {
          //console.log(values);
          if (typeof initialQuery !== "undefined") {
            // The useEffect has run already, so it's safe to just update the query string directly
            const querystring = formDataToQueryString(values);
            const path = `${window.location.pathname}?${querystring}`;
            window.history.pushState(null, "", path);
          }
        }}
        initialValues={{
          ...DEFAULT_FORM_DATA,
          ...queryStringToFormData(initialQuery),
        }}
        enableReinitialize
        onSubmit={async (values, { setSubmitting, setErrors }) => {
          setTimeout(() => {
            const { valid, errors, metaData } = formatValuesToMetaData(
              values,
              address!
            );
            if (valid) {
              write(metaData, 100);
            } else {
              setErrors(errors);
            }
            setSubmitting(false);
          }, 400);
        }}
      >
        {(formikProps: FormikProps<HypercertCreateFormData>) => (
          <DataProvider name={FORM_SELECTOR} data={formikProps.values}>
            <FormContext.Provider value={formikProps}>
              <form onSubmit={formikProps.handleSubmit}>{children}</form>
            </FormContext.Provider>
          </DataProvider>
        )}
      </Formik>
    </div>
  );
}

const formatValuesToMetaData = (
  val: HypercertCreateFormData,
  address: string
) => {
  // Split contributor names and addresses. Addresses are stored on-chain, while names will be stored on IPFS.
  const contributorNamesAndAddresses = val.contributors
    .split(",")
    .map((name) => name.trim());
  const contributorAddresses = contributorNamesAndAddresses.filter((x) =>
    isAddress(x)
  );

  // Mint certificate using contract
  const workTimeStart = val.workTimeStart
    ? new Date(val.workTimeStart).getTime() / 1000
    : 0;
  const workTimeEnd = val.workTimeEnd
    ? new Date(val.workTimeEnd).getTime() / 1000
    : 0;
  const impactTimeStart = val.impactTimeStart
    ? new Date(val.impactTimeStart).getTime() / 1000
    : 0;
  const impactTimeEnd =
    val.impactTimeEnd !== "indefinite" && val.impactTimeEnd !== undefined
      ? new Date(val.impactTimeEnd).getTime() / 1000
      : 0;

  const claimData = {
    contributors: _.uniq([address, ...contributorAddresses]),
    workTimeframe: [workTimeStart, workTimeEnd],
    impactTimeframe: [impactTimeStart, impactTimeEnd],
    workScopes: val.workScopes[0] || "",
    impactScopes: val.impactScopes[0] || "",
    rightsIds: val.rights.map((right) => right),
  };
  const claimDataValidationResult = validateClaimData(claimData);

  if (!claimDataValidationResult.valid) {
    return { ...claimDataValidationResult, metaData: undefined };
  }

  const metaData = {
    name: val.name,
    description: val.description,
    image: "",
    properties: claimData,
  };

  return { ...validateMetaData(metaData), metaData };
};